# Feedback on the World stack

Written while making World ID **load-bearing** in Halo — a live receipt-scanning
mini app (417,000 users: World Chain 59,253, Celo 308,316, Kaia 49,788;
1,173,623 receipts) whose new grocery-price index has to settle money on chain.
Against `@worldcoin/minikit-js` **2.0.3** in `apps/api` and **1.11.0** in
`apps/miniapp`, Developer Portal `/api/v2/verify`, on Cloudflare Workers.

**We did not integrate World ID this weekend.** It has verified point claims in
production since November 2025. What this weekend did was make the attestation
the thing an economic guarantee rests on, and that is where the friction below
comes from.

---

## Time to first success

Two datings, because collapsing them into one would be a lie.
**The original integration predates this work.** `apps/api/src/lib/verify.ts`
checks proofs server-side against `developer.worldcoin.org/api/v2/verify`; the
call site is `routes/client/point.ts:326`; `point_claims` has stored
`nullifier_hash`, `merkle_root`, `signal_hash`, `action` and `verification_level`
since the table was created (`drizzle/20251123020710_aromatic_valkyrie.sql:60`).

**This hackathon's piece — making the nullifier the identity the index counts in —
was roughly one working session.** Commit `569fe68` is four files, +279/−9, of
which 148 added lines are the test file and 86 the production change in
`epoch-index.ts`; 8 tests pass (`apps/api/src/test/matched-person-identity.test.ts`).
It was that fast for one reason: the proof check already existed and the attestation
was already in the database, so the work was a join, a filter and a number.

**A team starting from zero would not see that figure.** What we can offer them is the
size of the server half: `verify.ts` is **94 lines including its comments**.

## What was made load-bearing (needed to read the rest)

**Five of the index's seven integrity rules are counted in people**
(`docs/index-methodology.md:163`): `PERSON_CAP = 1` (`lib/matched-index/integrity.ts:20`),
`MIN_PEOPLE_PER_ITEM = 3` (`:29`) and `MIN_PEOPLE = 30` (`:35`) say so outright, and
`costToMoveOnePercent` (`:171`) prices an attack as spend × the per-item people floor.
Rules counted in people are worth exactly as much as a person is expensive to create —
and a person was keyed on a **wallet address**, which is free, so the floor was
decoration and the cost figure was quoting the price of the receipts alone. A person is
now keyed on their **orb-level World ID nullifier** where one exists
(`epoch-index.ts:176-181`, batched lookup at `:269-285`): two wallets belonging to one
verified human collapse into one person. **Orb only, deliberately** (`:279`) — device
attests a phone, and phones are farmable, so counting it as orb would put the hole back
while looking like it had been closed.

**Coverage is partial and we publish that fact.** Only World carries World ID and the
corpus spans three chains, so a wallet with no orb attestation still keys a person by
address. Every epoch reports `verifiedPeople` beside `people` (`epoch-index.ts:249-250`,
surfaced at `routes/admin/matched-index.ts:82-84`), and the ratio is how much of the
floor is load-bearing. On staging the KR series returns 1,543 observations and 19
people (`docs/ens-gateway.md:161`) — **one orb-verified.** Published on purpose.

## Friction encountered

**1. The verification level is chosen at the sheet and consumed a year later.**
`verification_level` is both a request parameter and a result. Our client asks for
`VerificationLevel.Device` as the minimum (`usePointClaim.ts:179`) and stores
whatever came back (`:212-213`). That one argument — picked when the flow was about
points and nothing else — decides whether a claim can ever be counted as a person.
Nothing presents it as a durable property of the record rather than a UI option, and
when several credentials satisfy a request we could not find a statement of which
one World App uses. So the orb share of our corpus is small *and* unpredictable.

**2. We cannot tell whether an orb nullifier and a device nullifier are the same
human.** Nothing we found says whether one person verifying one action at the two
levels yields one nullifier or two. We assume two, the fail-safe direction — only orb
rows enter the map (`epoch-index.ts:279-280`), so the error is undercounting — but it
is an assumption inside a security-critical join. One docs sentence settles it.

**3. No server-side package, so the verify call gets reimplemented by hand.**
`@worldcoin/minikit-js` is the client half: it assumes a browser and a wallet bridge,
and its root entry pulls in the React provider — `react` is a non-optional peer of
2.x (`lib/siwe.ts:206-210`) — so a Worker cannot import it. We wrote the POST
ourselves, plus the signal hash as `keccak256 >> 8` to fit the BN254 scalar field
(`verify.ts:28-40`). That shift is a protocol rule we re-derive in our own code, and
getting it wrong raises no typed error: it returns `invalid proof`, which reads to
everyone as the user's fault.

**4. The verifier answers HTML when it is unhappy, and `response.json()` blames
your code for it.** `verify.ts:78-93` reads the body as text first, because
`Unexpected token '<'` is a parse error about us rather than a report about them —
and it is what hid a **total outage of World point claiming behind a generic 500**.
Worse, next door: `usernames.worldcoin.org` 403s any request with no `User-Agent`
and the Workers runtime sets none (`routes/client/auth.ts:203-214`). Somebody learned
that there and wrote a literal; the same edge behaviour later took out every World
proof verification in production, two files away. Both are one docs line.

**5. `verifySiweMessage` looks complete and is not.** It checks nonce, statement,
timestamps and the signature against the Safe — never the domain, the chain id, or
whether the address inside the message is the one it ran the contract call against
(`lib/siwe.ts:200-204`). We add those three. A verifier that covers most of a check
is more dangerous than one that covers none: it stops the next person reading the
message themselves.

**6. The nonce charset is undocumented and fails on one platform only.** minikit 2.0.3
enforces `/^[a-zA-Z0-9]+$/` and throws otherwise; `crypto.randomUUID()` has hyphens.
Drop one `.replace(/-/g, '')` and every World login throws while Celo and Kaia carry
on working (`test/session-tokens.test.ts:25-34`).

**7. Ours rather than yours, but part of the honest cost.**
`point_claims.user_address` is a foreign key and Postgres does not index those
automatically (`20251123020710_aromatic_valkyrie.sql:78`; the sibling
`daily_point_claims` did get an explicit one, `20260111072934:13`), so a per-row
nullifier lookup over a 5,000-row window is 5,000 sequential scans — we batch one query
for the distinct wallets instead (`epoch-index.ts:269-285`). The join also lowercases,
because checksummed and lowercase are the same wallet (`:179`, `:284`; `users.address`
is the lower-cased form, `schema/users.ts:9-23`), tested at
`matched-person-identity.test.ts:140-147`.

## Missing capability or documentation

- **A nullifier's verification level cannot be recovered after the fact.** It is
  known only at proof time; if an app did not persist it, the attestation is gone
  and cannot be re-derived from the nullifier. Nothing answers "is this one orb?".
- **No `@worldcoin/verify` for servers.** The boundary already exists — the
  `@worldcoin/minikit-js/siwe` subpath *is* server-safe and we import it inside a
  Worker (`lib/siwe.ts:7-10`) — it is just not named, so every backend rewrites the
  same endpoint call and the same field shift.
- **Four things for the docs**, all above: which credential is used when more than one
  satisfies a request; whether orb and device nullifiers for one human relate; the
  nonce charset; and that the edge 403s a request with no `User-Agent`.

## The one improvement with the greatest impact

**An API that answers "what is this nullifier's verification level?" — a lookup by
`(app_id, action, nullifier_hash)` returning the level and when it was attested.**
The strongest form also answers "is the human behind this nullifier orb-verified
*now*"; if that is not expressible, saying so is the fix for friction item 2.

1. **It is the only item here we could not have worked around in code we control.**
   The workaround for a missing server package is 94 lines. The workaround for a
   missing attestation is a time machine.
2. **Our ability to do this at all was an accident of schema.** `point_claims`
   carries `verification_level` because somebody wrote it down in November 2025,
   before there was a use for it. The column that looks like its natural home —
   `users.verification_level` (`schema/users.ts:15-18`) — is read and served to the
   client (`routes/client/auth.ts:608`) and **written nowhere in this repository**;
   it has read `'none'` for every user since it was added. One schema review away
   from no orb signal and no way to get it back.
3. **It would raise coverage, not merely record it.** The orb count on the KR staging
   series is one person of nineteen, because most World claims in the corpus were taken
   with device as the minimum. A lookup is the only thing that could resolve those
   retroactively, rather than asking 59,253 users to re-verify a number they cannot see.
4. **It generalises past us.** Any app already gating an action on World ID sits on
   a Sybil floor it cannot price, and whether it can start is decided by whether it
   kept the right column. That should not be what decides it.
5. **It adds no privacy surface.** The nullifier is already app- and action-scoped, so
   scoping the lookup to the caller's own app id returns a level that app saw once.

**Why not the server-side package**, the other candidate: it is real — friction items
3, 4, 5 and 6 all follow from its absence, and item 5 is a security bug class, not a
DX complaint. But each of those we could fix, and did fix, in code we own, in a day,
and the `/siwe` subpath shows the server-safe boundary already exists in the package.
A bug class with a workaround loses to data loss with none.

## What worked, specifically

- **The nullifier is the right primitive.** Stable for a human across every wallet
  they use, scoped to an action, carrying no identity — so our person key stays
  internal and the published leaf set contains no person at all, asserted rather
  than assumed (`matched-person-identity.test.ts:107-124`).
- **Orb and device distinct, named and separable.** Because the level travels with the
  proof as a plain string we can store, we could take a *position* — orb only — rather
  than inherit a blended number we would have to defend later.
- **The verify endpoint as a plain HTTP POST.** No SDK, no Node built-ins, no
  polyfills; it runs unchanged at the edge in a Worker. That the server half *can* be
  one HTTP call is why this integration survived two years of our own runtime changes
  without a rewrite.
- **World's error codes are specific and worth forwarding.**
  `max_verifications_reached`, `credential_unavailable` and `verification_rejected`
  are three problems with three answers. We pass World's own reason to the screen
  (`point.ts:356-384`) — the difference between a user who can tell us what
  happened and one who can only say "nothing happened".
- **`minikit-js/siwe` is the only verifier that matches what World App emits**
  (`lib/siwe.ts:191-211`): its parser accepts the message `generateSiweMessage`
  produces and it knows both Safe payload shapes (v1 `isOwner`, v2
  `isValidSignature`). Writing that from EIP-1271 up would have cost days.
- **Easy to miss:** World ID is why this index has a people-denominated integrity model
  at all. 308,316 of our users are on Celo and 49,788 on Kaia, and for them the floor is
  still wallets — the World cohort is the only one where "30 people" means thirty.

## Where to verify the above

| Claim | File |
|---|---|
| Server-side verification, `fetch` + `viem`, 94 lines; `keccak256 >> 8`; HTML body read as text | `apps/api/src/lib/verify.ts`, `:28-40`, `:78-93` |
| Call site unchanged by this work; attestation persisted | `apps/api/src/routes/client/point.ts:326`, `:434-447` |
| Orb nullifier as person key; batched lookup and orb filter; `verifiedPeople` | `apps/api/src/lib/matched-index/epoch-index.ts:176-181`, `:269-285`, `:249-250` |
| The people-denominated rules | `apps/api/src/lib/matched-index/integrity.ts:20-38`, `:171` |
| Two wallets, one human, one person (8 tests) | `apps/api/src/test/matched-person-identity.test.ts` |
| Device requested as minimum, level stored as returned | `apps/miniapp/src/hooks/usePointClaim.ts:179`, `:212-213` |
| minikit root unusable server-side; checks `verifySiweMessage` omits | `apps/api/src/lib/siwe.ts:206-210`, `:200-204` |
| `users.verification_level` read, never written | `packages/database/src/schema/users.ts:15-18`, `apps/api/src/routes/client/auth.ts:608` |

The person key and what it costs a challenger: [`docs/index-methodology.md`](./docs/index-methodology.md).
