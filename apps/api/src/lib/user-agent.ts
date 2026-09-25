/**
 * Who we are, on every request we make to somebody else.
 *
 * Cloudflare Workers send no `User-Agent` unless one is set, and an anonymous
 * request is not merely impolite — it gets refused. Both of Worldcoin's hosts
 * sit behind an nginx that answers a request with no `User-Agent` with
 *
 *     403 Forbidden  (text/html)
 *
 * which arrived in our code as `Unexpected token '<'` from `response.json()`.
 * Every World ID point claim in production failed that way, and so did every
 * World username lookup at sign-in. Neither had a symptom anyone could act on:
 * the claim was a silent no-op on screen, and a missing username looks like a
 * user who has not set one.
 *
 * Identifying ourselves also means the other side can see who is calling and
 * tell us before they cut us off, which is the actual reason to do it.
 */
export const USER_AGENT = 'Halo/1.0 (+https://halo.humanlabs.world)';

/**
 * Headers for an outbound JSON request.
 *
 * A helper rather than a constant because forgetting one header on one call is
 * exactly the failure this file exists because of.
 */
export function outboundHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'User-Agent': USER_AGENT, Accept: 'application/json', ...extra };
}
