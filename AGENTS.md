# AGENTS.md

Conventions for writing code in this repository. Read before your first change.

These are not style preferences — each one exists because breaking it has cost us
something. Where that is true, the reason is written next to the rule.

---

## Layout

```
apps/api            Cloudflare Worker (Hono)
apps/miniapp        React SPA (Vite), served as a Worker with static assets
packages/contracts  Zod schemas, chain constants, ABIs — shared by API and frontend
packages/database   Drizzle schema + migrations
packages/onchain    Solidity (Foundry), deploy-time only
tooling/*           Shared ESLint / TypeScript config
```

`packages/contracts` is consumed from `dist/`. **Rebuild it after every change**
(`pnpm --filter @halo/contracts build`) or downstream typechecks will use stale
types. CI builds it before anything else for the same reason.

---

## API

### Routes

Every endpoint is a `createRoute` definition plus an `.openapi()` handler. There
is no second pattern.

```ts
const statRoute = createRoute({
  method: 'get',
  path: '/point/stat',
  tags: ['Point'],
  security: [{ Bearer: [] }],
  middleware: [userAuth] as const,
  responses: {
    200: { description: 'Point balances', content: { 'application/json': { schema: dataSchema(pointStatSchema) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
});

export const clientPointRoutes = new OpenAPIHono<AppEnv>().openapi(statRoute, async (c) => {
  const db = c.get('db');
  const address = c.get('address')!;
  // …
  return c.json({ data: { accumulated, current, claimable } }, 200);
});
```

Three details are load-bearing, and dropping any of them is what pushes people
toward `as any`:

1. **`middleware: [...] as const`** — without `as const` the middleware tuple
   widens and handler context inference collapses.
2. **Literal error codes** — `code: 'NOT_FOUND' as const`, so the response
   narrows to the declared union.
3. **Explicit status** — `c.json(payload, 200)`, matching a key in `responses`.

> The predecessor of this API used `chanfana` and needed **63 `as any` casts** in
> its router to compile. That is why the pattern above is mandatory. `as any`,
> `@ts-ignore` and `@ts-expect-error` are not allowed in `apps/api/src`.

### Response shape

Success is `{ data: ... }`. Failure is `{ error: { code, message } }`. Always.

- Import `errorSchema` and `dataSchema` from `@halo/contracts`. Do not redefine
  them per file.
- `HTTPException` is not used. Return `c.json({ error: … }, status)` and declare
  that status in `responses`.
- Clients branch on `code`, never on `message`. Message text is free to change.

Only two global handlers exist: `app.onError` → `INTERNAL_ERROR` 500 and
`app.notFound` → `NOT_FOUND` 404.

### Middleware

Global middleware is CORS and database injection — nothing else. Authentication
is attached per route so that the OpenAPI `security` declaration and the actual
enforcement live on the same lines and cannot drift apart.

`userAuth` and `adminAuth` are the only two. Both are in `src/middleware/auth.ts`.

### Auth

All signing and verification is in `src/lib/jwt.ts`. Routes call those functions
and nothing else.

Tokens are HS256 over `{ sub, verified?, iat, exp }`. There is deliberately no
`iss` or `aud`: tokens already issued to live users do not carry those claims,
so enforcing them would sign out the entire installed base on deploy. Adding
them is a staged change — accept both shapes for one expiry window first. The
same applies to the one-year lifetime, which is long for an access token and
only shrinks safely once refresh is carrying the load.

`ADMIN_API_TOKEN` is compared in constant time. String `===` exits at the first
differing byte, which leaks the prefix through response timing.

### Environment

Never hand-write the `Env` type. `pnpm --filter @halo/api cf-codegen` generates
`worker-configuration.d.ts` from `wrangler.jsonc`; it is committed and included
in `tsconfig.json`. App code only defines `Variables` and `AppEnv` in
`src/types.ts`.

**Changing `wrangler.jsonc` without re-running `cf-codegen` is a typecheck
failure waiting to happen.**

When you add a key, decide which of three places it belongs in — the repository
is public, so guessing wrong is a disclosure:

| Kind | Lives in | Test |
|---|---|---|
| Secret | Cloudflare, via `wrangler secret put`; CI injects from GitHub Environment secrets | Reading it helps an attacker |
| Worker config | `apps/api/wrangler.jsonc` → `env.<stage>.vars` | Safe to read, server-side only |
| Browser config | `apps/miniapp/.env.<stage>`, committed | Ships in the bundle anyway |

A keyed provider URL (`…/v2/<api-key>`) is a secret, not config, even though it
looks like a URL. And **nothing secret can be a `VITE_` variable** — Vite inlines
those into the bundle, so the prefix is a promise that the value is public.

Record the name in `.env.example` either way. It is the only complete list.

---

## Database

- One table per file under `src/schema/`, with that table's enums, indexes and
  `$inferSelect` / `$inferInsert` types alongside it.
- Everything lives in the `receipto` Postgres schema, not `public`. The name
  predates the product rename and **cannot be changed** — the live database
  and every applied migration reference it.
- Apps import from `@halo/database` only — never `drizzle-orm` directly. The
  package re-exports the operators so versions cannot drift between workspaces.
- Hyperdrive requires `postgres(conn, { prepare: false })`. It is set in
  `src/client.ts`; do not create connections elsewhere.

### Query rules

1. Independent queries go in `Promise.all`. Sequential awaits on a Worker are
   paid round-trips.
2. Never run the same condition twice to count and then fetch. Use a window
   function or a single scan.
3. Every list endpoint takes `limit` and `offset`. Admin screens included — the
   table that is small today is the one that takes production down later.
4. Filter in SQL, not in JavaScript. A `.filter()` after a full `select()` is a
   full table read.
5. No queries inside loops. Batch with `inArray`, chunked at ~500 ids.
6. Select the columns you need. `select()` on a table with a `text` blob column
   moves that blob over the wire every row.

### Migrations

`pnpm db:generate` creates them, CI applies them. `db:push` is for your local
database only. Never edit or delete a migration that has been applied — use
`db:drop`.

The pre-commit hook runs `db:generate` and blocks the commit if it produces new
files, which means a schema change without its migration cannot be committed.

---

## Mini app

- Routes are declared inline in `App.tsx`. Pages are `pages/<PascalCase>.tsx` and
  all lazy-loaded. There is no `router.tsx` and no `features/` directory.
- The layout wrapping `/app/*` has its own `<Suspense>` so the bottom navigation
  survives tab changes.
- `stores/` is Zustand (client state), React Query is server state, `lib/` is
  everything with no React dependency. Do not mix the three.
- Subscribe with selectors: `useAuthStore((s) => s.address)`, never the whole
  store.
- Platform detection happens in exactly one place, `lib/platform.ts`. There is
  **no production fallback** — an unrecognised host must fail loudly, because a
  mini app that silently runs against the wrong chain is undebuggable.
- Wallet differences live in `lib/auth/<platform>.ts` behind `getAuthAdapter()`.
  If you find yourself writing `if (platform === …)` in a component, the branch
  belongs in an adapter.
- Import with the `@/` alias, not `../../`.
- Read `import.meta.env` once in `lib/env.ts` and import typed values from there.

### i18n

40 locales live in `src/lib/i18n/locales/`. They are **loaded on demand** — do not
convert them to static imports, or every user downloads every language.

`pnpm test` runs `scripts/check-locales.mjs`, which fails on missing keys, extra
keys and mismatched `{{placeholder}}` names. A missing key silently falls back to
English and looks fine in review, which is exactly why the check is not optional.

---

## Naming

| Thing | Convention | Example |
|---|---|---|
| Components, pages | `PascalCase.tsx` | `BottomTab.tsx` |
| Hooks | `use` + camelCase | `useCameraStream.ts` |
| Zustand stores | camelCase file, `use*Store` export | `stores/auth.ts` → `useAuthStore` |
| Other modules | kebab-case | `lib/halo-mini-campaigns.ts` |
| Directories | lowercase, kebab for multiword | `lib/cross-promo/` |
| Constants | `UPPER_SNAKE_CASE` | `RECEIPT_MAX_AGE_DAYS` |

Files containing JSX are `.tsx`; everything else is `.ts`.

---

## Comments

Write them in English, and write them about **why**, not what. `// increment i`
is noise; `// MiniPay blocks native transfers, so CELO goes through the ERC-20
interface` is the reason someone does not break it next quarter.

Delete commented-out code. Git remembers it.

---

## Do not

- Commit a plaintext secret, wallet address of a real user, or internal hostname.
  `.env` and `.dev.vars` are gitignored; keep it that way.
- Add `as any` to make a route compile. Fix the schema.
- Run `db:migrate` or `db:push` against staging or production from your machine.
- Deploy by hand. Push to `main`.
- Copy a file between apps. If two places need it, it belongs in `packages/`.
- Leave a `TODO` without saying what unblocks it.
