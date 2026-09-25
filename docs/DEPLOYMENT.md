# Deployment

Everything runs on Cloudflare Workers in the Human Labs account. There are two
environments, `staging` and `production`, and they are selected by *how* the
deploy is triggered rather than by a flag:

| Trigger | Environment |
|---|---|
| push to `main` | staging |
| publish a GitHub release | production |

`.github/workflows/deploy.yaml` is the only thing that should be deploying.
Deploying from a laptop is possible and occasionally necessary, but it skips the
typecheck/test/migrate gates, so treat it as a break-glass action.

---

## Topology

Two Workers per environment. The mini app is **one** Worker serving **three**
custom domains; it resolves its platform from the hostname at runtime
(`platformFromHostname` in `packages/contracts/src/platform.ts`).

### production

| Worker | Hostname(s) |
|---|---|
| `receipto-api-prod` | `api.halo.humanlabs.world` |
| `receipto-miniapp-prod` | `miniapp.halo.humanlabs.world`<br>`celo-miniapp.halo.humanlabs.world`<br>`kaia-miniapp.halo.humanlabs.world` |

### staging

| Worker | Hostname(s) |
|---|---|
| `receipto-api-staging` | `api.receipto.seriesc.dev` |
| `receipto-miniapp-staging` | `miniapp.receipto.seriesc.dev`<br>`celo-miniapp.receipto.seriesc.dev`<br>`kaia-miniapp.receipto.seriesc.dev` |

The Worker names say `receipto` because that is what this product was called
when the Workers, the R2 bucket and the Postgres schema were created. Renaming a
Worker creates a new one and orphans the old, so the names stay.

> The `miniapp.` prefix with no chain in it is **World**. It shipped first and
> took the bare name before there was anything to disambiguate. The hostname map
> in `packages/contracts/src/platform.ts` encodes exactly these six hostnames and
> is covered by tests — if you add or rename a domain, that map is the other half
> of the change.

---

## The one-time cutover

**This section stops being relevant once it has been done once.** Read it before
the first production release from this repo.

Today, three separate Workers serve the three production mini app domains:

```
miniapp.halo.humanlabs.world       →  receipto-miniapp-prod        (World)
celo-miniapp.halo.humanlabs.world  →  receipto-celo-miniapp-prod   (Celo)
kaia-miniapp.halo.humanlabs.world  →  receipto-kaia-miniapp-prod   (Kaia)
```

This repo deploys a single Worker named `receipto-miniapp-prod` — the same name
as the World Worker — and claims all three domains.

### What actually happens

`wrangler deploy` behaves differently depending on whether it has a terminal:

- **In CI (no TTY)** it sets `override_existing_origin` and
  `override_existing_dns_record` and **takes the domains over without asking.**
- **From a terminal** it prints `Custom Domains already exist for these domains:`
  and asks for confirmation. Declining aborts the deploy.

So the cutover is *atomic* and needs no manual detach step: the moment the
production deploy finishes, all three hostnames point at the new Worker. There
is no window where a domain is unattached.

The flip side is that there is **no staged rollout**. Publishing the release
moves 100% of Celo and Kaia production traffic to the new app in one step. Do it
deliberately:

1. Let the staging deploy run and **exercise all three staging domains** —
   login, scan, claim — not just `miniapp.receipto.seriesc.dev`. The three
   domains run the same bundle but take different code paths.
2. Publish the release.
3. Watch the API for auth errors specifically. Session compatibility is the
   thing most likely to break: the JWT format and the `{ data }` response
   envelope were deliberately kept identical to the old API so that sessions
   issued by the old stack keep working. If those were changed, every logged-in
   user is signed out at once.
4. Leave `receipto-celo-miniapp-prod` and `receipto-kaia-miniapp-prod` deployed
   but dark for a soak period. They cost nothing and they are the rollback.

### Rollback

Redeploy the old Worker from the legacy repo. It takes its domain back by the
same override mechanism:

```bash
# from the legacy monorepo
pnpm celo deploy:production      # reclaims celo-miniapp.halo.humanlabs.world
pnpm kaia deploy:production      # reclaims kaia-miniapp.halo.humanlabs.world
pnpm world deploy:production     # reclaims miniapp.halo.humanlabs.world
```

For the API, prefer Cloudflare's version rollback over redeploying:

```bash
cd apps/api
pnpm exec wrangler rollback --env production
```

**Database migrations do not roll back.** They run in the `prepare` job, before
anything is deployed, and a rolled-back Worker will be talking to a
forward-migrated schema. Keep migrations additive — add nullable columns, do not
drop or rename — so that the previous Worker version still functions against the
new schema. This is the constraint that makes rollback safe; it is not optional.

Once you delete the old Workers the rollback path is gone. Do not delete them on
release day.

---

## Routine deploys

Nothing to do beyond merging. The workflow diffs paths and skips an app that did
not change:

- `apps/api/**` or `packages/**` → API deploys
- `apps/miniapp/**` or `packages/**` → mini app deploys

A change under `packages/**` deploys both, which is correct — both consume the
shared packages.

The change detection diffs against **the last commit that actually deployed
successfully**, not the previous commit, so a change is never silently skipped
because an earlier run failed. Put `DEPLOY_ALL` in a commit message to force
everything.

Pipeline order in `prepare` is deliberate:

```
install → build contracts → typecheck → test → db:migrate → sync secrets → deploy
```

Tests run before migrations so that a failing test stops the pipeline without
having touched the schema.

### Promoting staging to production

Every successful staging deploy opens a **draft** release. Publishing it triggers
the production deploy. The draft stays a draft unless the commit message has
`RELEASE` **alone on a line**, which is the mechanism for "a human looked at
staging".

The marker used to be `CHECKED`, tested with `contains()` — a workflow
expression function that is a case-insensitive substring match. A commit whose
body read "we have not checked yet" published a production release. It did not
deploy, and only by accident: a release created with `GITHUB_TOKEN` does not
trigger another workflow, so the repository was left advertising a Latest
release that had never shipped. The check is a case-sensitive `grep -qx` now,
so no sentence can trip it.

Publishing a draft by hand — from the Releases page or `gh release edit
<tag> --draft=false` — uses your own token, so that event *does* fire the
deploy. That is the normal path.

---

## Secrets

Secrets are never in this repository, in any form — not even encrypted, because
a committed ciphertext is an offline cracking target that no rotation can recall.
They live in two places only: **GitHub Environment secrets** (`staging` and
`production`) and **Cloudflare**.

The `prepare` job binds to a GitHub Environment, which is what makes
`secrets.JWT_SECRET` resolve to a *different* value for staging and production.
Without that binding both stages would read the same secrets and a staging deploy
would overwrite production's. If you add a job that touches secrets, it needs the
`environment:` key too.

The sync step pushes each secret to Cloudflare with `wrangler secret put`. An
unset secret is **skipped, not written as an empty string** — an empty
`JWT_SECRET` fails open in ways an absent one does not.

Current list (also in `.env.example`, names only):

```
JWT_SECRET              SESSION_HMAC_SECRET     ADMIN_API_TOKEN
OPENAI_API_KEY          SERVER_SIGNER_PRIVATE_KEY
TURNSTILE_SECRET_KEY    MAILEROO_API_KEY
CELO_RPC_URL            WORLDCHAIN_RPC_URL      KAIA_RPC_URL
DROP_API_URL            DROP_ID
```

The RPC URLs are secrets because our provider URLs carry an API key in the path.

Setting one by hand:

```bash
cd apps/api
echo -n "<value>" | pnpm exec wrangler secret put JWT_SECRET --env production
```

### Rotating `ADMIN_API_TOKEN`

`ADMIN_API_TOKEN` guards every `/v1/admin/*` route and is compared in constant
time, so its only weakness is being guessable or leaked. Rotate it by updating
the GitHub Environment secret and re-running the workflow — or immediately, with
`wrangler secret put`, which takes effect on the next request without a deploy.

There is no dual-token grace period. Anything holding the old token breaks at
once, so rotate when you can watch it.

---

## Deliberately not here

Two operator-facing features from the legacy stack were left out. Neither is on
a user-facing path, but if you are expecting them, this is why they are missing.

**Daily stats report to Telegram.** The legacy API had a `0 0 * * *` task that
posted a production-only summary to a Telegram channel. It is gone, along with
the bot token it needed. Worker analytics and the admin stats endpoints cover
the same ground without adding a credential to a public repository.

**Bulk email to raffle winners.** `POST /v1/admin/raffle-payout/send-emails`
sent a templated blast to everyone owed a payout. It is not here. The payout
itself is unaffected — `GET /admin/raffle-payout/winners` and
`POST /admin/raffle-payout/record` both exist, so you can still list who is owed
what and record the transaction hashes. Only the notification step needs an
external tool.

Email sending itself still works: `MAILEROO_API_KEY` is live and used for
address-verification OTPs in `apps/api/src/routes/client/halo.ts`.

---

## Sharp edges

**The bare Worker names are a footgun.** The top of each `wrangler.jsonc` says
`halo-api` / `halo-miniapp`, but every real deploy passes `--env staging` or
`--env production`, which use the `receipto-*` names. Running `wrangler deploy`
with **no** `--env` does not fail — it creates brand new Workers called
`halo-api` and `halo-miniapp` with no routes, no bindings and no secrets. Always
pass the environment.

**Staging and production share one R2 bucket** (`receipto`). Staging receipt
uploads land in the same bucket as production's. Nothing distinguishes them at
the object level beyond the key. Do not write a cleanup job that deletes by age
or prefix without checking this first.

**The staging Hyperdrive config is shared with another product.** Staging's
Hyperdrive id points at a database that is not exclusively ours. Production has
its own. Treat staging data as other people's data.

**The Postgres schema is named `receipto`,** not `halo` or `public`. Same
history as the Worker names. `pgSchema('receipto')` in
`packages/database` is load-bearing; changing it orphans 17 applied migrations
and every row behind them.

**Cron triggers only exist on the API.** `"crons": ["0 0 * * *"]` must match a
key in `apps/api/src/scheduled/index.ts` character for character — Cloudflare
passes the expression through verbatim, and an expression with no matching key
registers a trigger that fires into nothing.

**`account_id` is deliberately absent** from both `wrangler.jsonc` files;
wrangler reads `CLOUDFLARE_ACCOUNT_ID` from the environment. Keep it that way —
it costs nothing and removes one identifier from the blast radius of a leaked
token.

---

## Running a deploy by hand

Break-glass only. This skips typecheck, tests and migrations.

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...

pnpm --filter @halo/api deploy:production
pnpm --filter @halo/miniapp deploy:production
```

From a terminal wrangler will prompt before moving a custom domain. Read the
prompt — it names the Worker currently serving that hostname, which is the last
check you get that you are about to repoint production traffic.

Verify a dry run first; it resolves every binding without uploading:

```bash
cd apps/api && pnpm exec wrangler deploy --dry-run --env production
```
