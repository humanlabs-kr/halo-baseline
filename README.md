# Halo

Scan a paper receipt, get rewarded onchain.

Halo is a mini app that turns everyday purchase receipts into onchain rewards. A
user photographs a receipt inside their wallet app, a vision model extracts and
scores it, and verified receipts become points that can be claimed as tokens on
Celo, World Chain, or Kaia.

This is the running system, not a demo or a trimmed copy. What is in this
repository is what serves `api.halo.humanlabs.world` and the three mini app
domains beside it, to real users, today. Production configuration is committed;
only secrets are not.

Halo first shipped at ETHGlobal Buenos Aires 2025. That submission is preserved
unchanged at [humanlabs-kr/halo-ethglobal-2025](https://github.com/humanlabs-kr/halo-ethglobal-2025);
this repository is where it went afterwards.

## Three things production has already decided

Changing any of these is a migration, not an edit.

- **The Solidity in `packages/onchain` is deployed** behind a UUPS proxy holding
  real balances. Its inheritance, storage layout and EIP-712 domain are fixed by
  what is on chain. `CeloPointClaimUpgradableV2` is live on both environments.
- **The database in `packages/database` has data in it.** Its Postgres schema is
  named `receipto` — an old product name that cannot be renamed — and its 17
  migrations are already applied.
- **The vision model is load-bearing.** Receipt analysis runs
  `qwen/qwen3-vl-32b-instruct` through OpenRouter, and the award is
  `floor(BASE_POINT_PER_RECEIPT × qualityRate / 100)`. Whatever score that model
  returns *is* the user's payout, and the 30-point floor is the accept/reject
  boundary. Swapping the model re-prices every scan.

Each is called out where it matters in the code. `AGENTS.md` has the conventions.

---

## What is in the box

| Piece | Path | What it does |
|---|---|---|
| **API** | `apps/api` | Hono on Cloudflare Workers. Auth, receipt intake, analysis queue, points, raffle, admin. |
| **Mini app** | `apps/miniapp` | React + Vite SPA. One app, three wallet platforms, selected at runtime. |
| **Shared contracts** | `packages/contracts` | Zod schemas, chain constants and ABIs shared by API and frontend. |
| **Database** | `packages/database` | Drizzle ORM schema and migrations (PostgreSQL via Hyperdrive). |
| **Onchain** | `packages/onchain` | Solidity point-claim contract (Foundry, solc 0.8.22 — pinned to the deployed proxy). |
| **Hedge** | `packages/hedge` | Cover on grocery inflation: index oracle, vault, Uniswap v4 hook, ENS resolver (Foundry, solc 0.8.26). |
| **Tooling** | `tooling/*` | Shared ESLint and TypeScript configs. |

### How a receipt becomes a reward

```
 wallet app          Cloudflare Worker                     PostgreSQL
┌──────────┐        ┌─────────────────┐                  ┌──────────┐
│ miniapp  │──POST─▶│  /v1/receipts   │──── insert ─────▶│ receipts │
│  camera  │        └────────┬────────┘   status=pending └──────────┘
└──────────┘                 │
                             │ enqueue
                             ▼
                    ┌─────────────────┐
                    │ analysis queue  │── vision model ──▶ score + fields
                    └────────┬────────┘
                             │ status = claimable | rejected
                             ▼
┌──────────┐        ┌─────────────────┐                  ┌──────────┐
│ miniapp  │◀─sig───│ /v1/point/claim │─── sign claim ──▶│  signer  │
│  claim   │        └─────────────────┘                  └──────────┘
└────┬─────┘
     │ claimPoints(amount, claimId, deadline, signature)
     ▼
┌──────────────────────┐
│ PointClaim contract  │  Celo
└──────────────────────┘
```

The server never sends tokens. It signs a claim that the user redeems from their
own wallet, so a compromised API cannot drain the reward pool — it can only
authorise claims, which are capped per receipt and single-use by `claimId`.

Only Celo settles onchain. World and Kaia credit points off-chain; World gates
the claim behind a World ID proof instead.

### One app, three platforms

The mini app is **not** built three times. `apps/miniapp/src/lib/platform.ts`
resolves the platform from the hostname at runtime, and wallet-specific behaviour
lives behind an adapter:

```
lib/auth/adapter.ts  →  world.ts   (World App MiniKit)
                        celo.ts    (MiniPay injected provider)
                        kaia.ts    (Kaia DappPortal SDK)
```

Adding a fourth chain means adding one adapter file and one entry to the switch —
not copying the app.

The map in `packages/contracts/src/platform.ts` resolves the *first label* of
the hostname — `miniapp.` is World, because World shipped first and took the
bare subdomain before the platform names existed. Those labels are baked into
installed mini apps and cannot be renamed. An unknown label returns `null`
rather than a guess, since a mini app that assumes the wrong platform
authenticates against the wrong chain and fails in ways nobody traces back to
DNS. Renaming a route in `apps/miniapp/wrangler.jsonc` without updating that map
is exactly that failure.

### Languages

21 locales in `apps/miniapp/src/lib/i18n/locales/`, chosen from production
country data rather than ambition. Two kinds of key live there: opaque ids
(`L-fZMUbLsR`), which render as themselves when missing and so are mandatory
everywhere, and source-text keys, whose key *is* the English copy and which fall
back cleanly.

`pnpm --filter @halo/miniapp test` runs `check-locales`, which is stricter than
it looks: it compares every locale to the reference, compares the *source* to
the reference to catch a `t()` call for a key nobody declared, and boots a real
i18next to prove each shipped locale resolves to itself. That last check exists
because a single i18next option once made ten region-tagged locales silently
fall back to English with every file complete and every test green.

---

## Quick start

**Requirements:** Node.js 22, pnpm 9.15.4 (pinned in `packageManager`), a
PostgreSQL database.

```bash
pnpm install

# .env.example is the key manifest. Copy it where each app looks and fill in
# what you need — see "Environment" below.
cp .env.example apps/api/.dev.vars     # wrangler dev reads .dev.vars, not .env
cp .env.example apps/miniapp/.env
cp .env.example packages/database/.env
```

Point `DATABASE_MIGRATION_URL` at a local Postgres, create the schema, and start
both apps:

```bash
pnpm db:push        # local databases only — never staging or production
pnpm dev:apps
```

- API — http://localhost:8001 (OpenAPI UI at `/swagger`)
- Mini app — http://localhost:8000

To open the mini app inside a real wallet app you need a public https origin.
`pnpm dev` starts a Cloudflare tunnel alongside the dev servers; set
`CLOUDFLARE_TUNNEL_TOKEN` in `.env.local` first. Without a token it is skipped
and only the local servers start.

---

## Environment

Configuration is split three ways by who is allowed to read it. This repo is
public, so the split is load-bearing rather than cosmetic.

**1. Public runtime config — committed.** Non-secret Worker settings live in
`apps/api/wrangler.jsonc` under each environment's `vars`: API URL, CORS
domains, the World app id, the claim contract address. Knowing them buys an
attacker nothing.

**2. Public build-time config — committed.** `apps/miniapp/.env.staging` and
`.env.production`. Every `VITE_` value is compiled into the browser bundle and
is therefore already public the moment the app ships; committing them is what
makes a clean checkout produce the same build. **If a value must stay private it
cannot be a `VITE_` variable** — it belongs behind the API.

> The RPC entries in those files are intentionally blank, because a provider URL
> carries its key in the path. Unset is a supported state: viem falls back to
> each chain's default endpoint. To ship a keyed one, set the matching
> `VITE_*_RPC_URL` GitHub Environment secret and the deploy step compiles it in.
> Keep those separate from the API's `*_RPC_URL` secrets — anything named
> `VITE_` is downloaded by every user.

**3. Secrets — never in this repo, in any form.** Not even encrypted: a
committed ciphertext is an offline cracking target that never expires. They are
set directly on Cloudflare and injected in CI from GitHub Environment secrets.

```bash
# once per environment, from a machine that already has the value
cd apps/api
echo -n "<value>" | pnpm exec wrangler secret put JWT_SECRET --env production
```

The full list of secret keys is in `.env.example` and in the sync step of
`.github/workflows/deploy.yaml`. `.env.example` is the single manifest of every
key the system reads — names only, no values.

A few keys deserve a note:

- `ADMIN_API_TOKEN` — guards every `/v1/admin/*` route. Use 32+ random bytes.
  It is compared in constant time, but a guessable value defeats that.
- `SERVER_SIGNER_PRIVATE_KEY` — signs claim authorisations. It holds no funds and
  cannot move tokens; it only attests that a receipt earned N points. The
  contract's `serverSigner` must match it.
- `OPENROUTER_API_KEY` — every receipt is scored through it. No credit, no
  scoring: the queue marks the receipt rejected and moves on.
- `JWT_SECRET` — changing it signs out every logged-in user at once.
- `DEPLOYER_PRIVATE_KEY` — used only by `packages/onchain` at deploy time. Keep it
  out of the Worker environment.

---

## Commands

```bash
pnpm dev              # all apps + tunnel
pnpm dev:apps         # all apps, no tunnel
pnpm build
pnpm typecheck
pnpm lint
pnpm test

pnpm db:push          # apply schema directly (local only)
pnpm db:generate      # create a migration from schema changes
pnpm db:migrate       # apply migrations (CI runs this; do not run against prod by hand)
pnpm db:studio        # Drizzle Studio
```

Scoped to a single workspace:

```bash
pnpm --filter @halo/api dev
pnpm --filter @halo/miniapp build
pnpm --filter @halo/onchain test
```

### Tests

```
apps/api             70   SIWE verification, session issuance, token shape
packages/contracts   15   hostname → platform resolution
packages/onchain     29   Foundry, including a V1→V2 upgrade that must preserve balances
packages/hedge       91   Foundry. Fee-on-transfer and reentrant collateral, a crossed-holdings
                          settlement fuzz, and the hook's address bits
apps/miniapp          –   check-locales (see "Languages")
```

The API suite is about security properties, not implementation details: every
signature is a real EIP-191 signature from a real key, and the only thing
substituted is the JSON-RPC node. It exists because the login path has broken
twice in ways typecheck and build were both happy with.

`packages/onchain` and `packages/hedge` need Foundry (`forge`) on PATH; CI installs
it. They are separate packages because they pin different compilers, and that is
deliberate rather than untidy — see `packages/hedge/README.md`.

### Checking extraction against real receipts

Extraction quality is the product, and it cannot be tested from a laptop: the
model key lives in the Worker, and the upload path is behind a Turnstile that
correctly refuses to be scripted. `POST /admin/test/reparse` is the instrument
for it. It draws receipts already in storage, runs the current prompt over
their images, and returns what it got beside what is on file. **It writes
nothing** — no status changes, no points move — so it is safe to point at
production, which is the only data worth pointing it at.

```bash
curl -s -X POST "$API/v1/admin/test/reparse" \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"sample":12,"withLines":true,"ignoreAge":true}'
```

| field | meaning |
|---|---|
| `receiptIds` | specific receipts, up to 20. Takes precedence over sampling |
| `sample` | how many to draw at random instead |
| `country` · `status` | narrow the draw |
| `withLines` | only receipts that already have line items — the corpus the price index is actually built from |
| `ignoreAge` | judge each receipt as of its own purchase date. Without this almost everything comes back `too-old`, because everything in the bucket was bought before today, and the extraction failures underneath are invisible |

Each result carries the stored fields, the fresh read, the verdict today's
rules would reach, and the list of fields that disagree. Run it before and
after a prompt change; a prompt tuned on the handful of receipts someone
happened to be looking at is how a five-kilo sack came to be priced as one.

---

## Deployment

Everything runs on Cloudflare Workers.

- Push to `main` → staging.
- Publish a GitHub release → production.
- Unchanged apps are skipped.

`.github/workflows/ci.yaml` gates pull requests on lint, typecheck and test.
`.github/workflows/deploy.yaml` runs typecheck → test → migrations → secret sync
→ deploy, in that order: a failing test stops the pipeline before it has touched
the schema.

Secrets are read from **GitHub Environment** secrets (`staging` and
`production`), so the same workflow file cannot push a staging value over a
production one. Both environments require a manual approval before their jobs
run.

The mini app is one Worker serving three custom domains, so a production deploy
repoints all three chains at once. That, the rollback path, secret rotation and
the sharp edges are in [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) — read it
before your first production release.

Forking this to run your own stack? The two `wrangler.jsonc` files point at our
Cloudflare resources by id. Create your own Hyperdrive config, R2 bucket, queues
and domains, then replace those ids and routes.

---

## Building on this

Good places to start:

- **New chain** — add an adapter in `apps/miniapp/src/lib/auth/`, a chain entry in
  `packages/contracts/src/platform.ts`, and a route in `apps/miniapp/wrangler.jsonc`.
- **New reward mechanic** — the raffle in `apps/api/src/routes/client/raffle.ts` is
  self-contained and a reasonable template.
- **Better extraction** — receipt analysis lives in `apps/api/src/lib/receipt-processor/`.
  The prompt and the scoring rule are in one place. Re-validate against real
  receipts before changing either; see the note at the top of this file.

Conventions that keep this codebase navigable are written down in
[AGENTS.md](./AGENTS.md) — worth five minutes before your first pull request.

---

## License

[MIT](./LICENSE)
