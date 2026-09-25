import { API_URL } from '@/lib/env';

/**
 * Shared transport for the hand-written domain clients in this folder.
 *
 * Two things live here rather than being repeated per domain: the response
 * envelope the API answers with, and the cookie credentials the session
 * depends on. Duplicating either is how one endpoint quietly ends up
 * unauthenticated, or how one screen starts reading `res.data.data`.
 *
 * Every 2xx body is `{ data: ... }` and every error body is
 * `{ error: { code, message } }` — see `dataSchema` / `errorSchema` in
 * `@halo/contracts`, which the server builds its routes from.
 */

interface ErrorEnvelope {
  error: { code: string; message: string };
}

/**
 * A failed request, carrying the server's error `code` alongside the message.
 *
 * It subclasses `Error` so `instanceof Error` and `.message` keep working in
 * React Query, toasts and `catch` blocks that do not care about the code.
 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    /** Server error code, e.g. `ALREADY_CLAIMED`. Null if the body was unreadable. */
    readonly code: string | null,
    readonly status: number,
    /** Seconds from the `Retry-After` header; only the rate-limited endpoints set it. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/**
 * Whether the server answered with one of these error codes.
 *
 * Branch on this, never on `error.message`. The message is display copy: it
 * gets reworded, shortened and translated, so a caller that pattern-matches it
 * breaks the day someone fixes a typo — with no type error, no failing test,
 * just a branch that silently stops firing. The `code` is part of the API
 * contract and is the only part safe to compare against.
 */
export function hasApiErrorCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof ApiRequestError && error.code !== null && codes.includes(error.code);
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export interface ApiRequestInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: QueryParams;
  /** JSON request body. Mutually exclusive with `formData`. */
  body?: unknown;
  /** Multipart body. `Content-Type` is left unset so the browser can add the boundary. */
  formData?: FormData;
  signal?: AbortSignal;
}

/**
 * Absolute URL for an API path, query string included.
 *
 * Exported because a couple of endpoints are consumed by the browser rather
 * than by `fetch` — the receipt image is an `<img src>`, not a response body.
 */
export function apiUrl(path: string, query?: QueryParams): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined) search.set(key, String(value));
  }

  const queryString = search.toString();
  return `${API_URL}${path}${queryString ? `?${queryString}` : ''}`;
}

/** Where the refresh exchange lives. Never retried through itself. */
const REFRESH_PATH = '/v1/auth/session/refresh';

/**
 * In-flight renewal, so N simultaneous 401s cause one exchange.
 *
 * The app opens several queries at once on every screen. Without this they
 * would each POST to refresh, and since the endpoint rotates the refresh token
 * the later ones would be presenting a cookie the earlier ones had already
 * replaced — a self-inflicted sign-out under exactly the conditions this is
 * meant to recover from.
 */
let renewing: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  renewing ??= fetch(apiUrl(REFRESH_PATH), { method: 'POST', credentials: 'include' })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      renewing = null;
    });

  return renewing;
}

/**
 * Sends the request, unwraps `{ data }`, and throws `ApiRequestError` otherwise.
 *
 * Call sites receive the payload itself: no envelope to peel, no result tuple
 * to destructure, and one place that knows what a Halo error looks like.
 */
export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { method = 'GET', query, body, formData, signal } = init;

  const send = () => {
    const headers = new Headers();
    if (body !== undefined) headers.set('Content-Type', 'application/json');

    return fetch(apiUrl(path, query), {
      method,
      headers,
      body: formData ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal,
      // The session cookie is http-only and set on the API's domain, not the app's.
      credentials: 'include',
    });
  };

  let response = await send();

  // One retry, through the refresh cookie. The access token is deliberately
  // short-lived now, so a 401 is the expected answer for anyone who has not
  // opened the app in a week — not an error to show them. `refreshSession`
  // collapses concurrent attempts, so a screen firing five queries at once
  // renews once and retries five times rather than racing five renewals.
  if (response.status === 401 && path !== REFRESH_PATH && (await refreshSession())) {
    response = await send();
  }

  if (!response.ok) {
    // A proxy or edge error page is not JSON; falling back keeps the real status
    // visible instead of replacing it with a parse error.
    const envelope = (await response.json().catch(() => null)) as ErrorEnvelope | null;
    const retryAfterSeconds = Number(response.headers.get('Retry-After'));

    throw new ApiRequestError(
      envelope?.error.message ?? `Request failed (${response.status})`,
      envelope?.error.code ?? null,
      response.status,
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : null,
    );
  }

  const envelope = (await response.json()) as { data: T };
  return envelope.data;
}
