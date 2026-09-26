# Index methodology

This document is what `rulesHash` commits to. Every parameter below is hashed
and written on chain at `openEpoch`, **before any observation for that epoch
exists**, which is what stops whoever publishes from picking — after seeing the
data — the variant that happens to pay their own position.

Changing anything here changes the hash. An epoch that needs different rules is
a different epoch.

---

## What is being measured

The change in what households actually paid for the same product at the same
shop, between two consecutive windows.

Not the change in a category average. That distinction is the whole design, and
the reason is worth stating before the arithmetic:

> Rice gets dearer, so shoppers move from the premium brand to the cheap one.
> Every price on the shelf went up. A median of "rice" unit prices goes **down**,
> because the mix moved and the median was measuring the mix.

An index built that way falls in the month a household most needs cover. Fixing
the product removes the effect completely, because each item is only ever
compared with itself. This is why statistical agencies match models rather than
average categories, and it is not a refinement — it is the difference between
an index that hedges and one that pays out backwards.

---

## Item identity

An item is `(outlet, product)`, both normalised.

**Product** — NFKC, strip leading till codes and reduced-tax marks, case fold,
collapse punctuation and whitespace.

NFKC is doing more than it looks. Japanese receipts mix full-width and
half-width freely, so `コシヒカリ ５ｋｇ` and `コシヒカリ 5kg` are one product
printed by two registers; only the fold makes them one string. The same pass
unifies half-width katakana, which older thermal printers still emit.

**The size token stays.** `食パン 6枚切` and `食パン 8枚切` are different
products at different prices. Folding them together puts back exactly the mix
drift this exists to remove.

**Outlet** — the same treatment plus legal forms (`株式会社`, `Co., Ltd.`), so
one shop that prints its own name three ways is not three outlets each below
the diversity floor. Branch suffixes are kept: two branches price differently.

---

## The window

Cut on **upload time**, not the printed date.

This is a real concession and it is deliberate. The printed date is the one
that says when a price was paid, which is what an index wants. But the archive
holds receipts bought recently and uploaded long afterwards, and nothing
distinguishes them — so cutting on the printed date lets anyone move a closed
period by uploading old paper into it. No forgery, no sybil, just a shoebox.

Upload time gives up some accuracy about *when* and buys a window that cannot
be edited after it closes. For a number that settles a contract, that trade is
the right way round.

---

## The arithmetic

**Per person, per item, per period:** one observation, their median. Not their
first, which rewards timing; not their mean, which one outlier moves. Their
expenditure is still summed, because they really did spend it.

**Per item, per period:** the median across people.

**Price relative:** `r = p(t) / p(t−1)`, only for items present in **both**
periods. An item that appears this month and not last contributes nothing; it
enters next period, when there is something to compare it against.

**Elementary aggregate:** Jevons — the unweighted geometric mean of relatives,
computed in log space.

Geometric, not arithmetic. A price that doubles and then halves has not
changed, and only a geometric mean says so: 2 and 0.5 average to 1 in logs and
to 1.25 in levels. An arithmetic mean of ratios drifts upward on volatility
alone, and on a contract that settles against the drift that is a bias which
pays one side.

Log space is not fussiness either — the direct product of a few thousand ratios
underflows to zero well before it finishes, silently.

**Upper level:** Törnqvist — the same geometric mean weighted by expenditure,
using the average of the two periods' shares.

The weights come from the receipts themselves. A survey-based index has to take
expenditure shares from a household budget survey run separately and years
apart; every line here carries its own total. That is the one place transaction
data is strictly better than a survey rather than merely faster.

**Published value:** the change in basis points, as a signed integer. Rounded
half away from zero rather than to even, so a long run of small moves is not
biased in one direction.

---

## Integrity rules

Each is a defence against a specific attack, and is named that way.

| Rule | Value | What it stops |
|---|---|---|
| Source | `vision` only | Seeded demo rows becoming a settled number |
| Per-person cap | 1 per item per period | One **person** being a price series |
| Distinct people per item | 3 | Sybil across addresses on one item |
| Distinct outlets per series | 3 | Colluding with one shop |
| Distinct people per series | 30 | A small ring being the sample |
| Matched pairs per series | 20 | Publishing on noise |
| Trim | 5% of each tail, in logs | A single forged extreme |
| Ratio band | [0.5, 2.0] | A specification change read as a price move |

The band earns its place. A supermarket item that halves or doubles between two
consecutive periods is almost never a price move — it is a pack size the
normaliser missed, or a promotion priced per unit instead of per pack. Letting
those through is how a labelling change settles a contract.

Trimming is symmetric **in logs**. A halving and a doubling are the same size
of move, and trimming in levels cuts more of one tail than the other.

### Which rows are admitted at all

The corpus holds two kinds of line item. `source = 'vision'` was extracted from
a photographed receipt. `source = 'seed'` was generated so a demo wallet has a
basket to render — the merchant, date and printed total are real, the split
across items is not.

**Only `vision` enters the index**, and that is in the committed rules rather
than only in the query, because what data is admitted is the most load-bearing
rule there is: a challenger who cannot see it cannot tell whether the published
figure was computed over the population they are recomputing over.

This shipped wrong. The filter was missing, so synthetic prices could have
reached a figure that gets signed, bonded and settled on chain, and nothing
would have indicated it — seeded rows are well-formed and the aggregation is
perfectly happy to average them. It was found by reading the seed script's own
header, which states the rule in the imperative, and noticing the index was not
obeying it.

For the record, no published number was ever contaminated: the staging corpus
reports identical counts before and after the filter, so every row in it was
vision-extracted. This was a missing guard rather than an observed leak, and
the distinction is worth keeping — a fix does not need invented evidence.

`rulesHash` moved as a result and the rules version is now `halo-matched-2`.
The epoch already finalised on Sepolia was published under `halo-matched-1`;
that is what committing a rules hash is *for*, and the old value stays valid
for the epoch that used it.

### What "one person" means, and what it is worth

Five of the seven rules above are counted in people. **All five are worth
exactly as much as a person is expensive to create**, and for a long time this
pipeline keyed a person on their wallet address — which is to say, on nothing.
An attacker with a script has as many wallets as they like, so the per-person
cap capped nothing and `costToMoveOnePercent` was reporting the price of the
receipts alone.

A person is now keyed on their **orb-level World ID nullifier** where one
exists. A nullifier is stable for a human across every wallet they use, so two
wallets belonging to the same verified person collapse into one person instead
of counting twice. Halo has verified World ID server-side for point claims
since long before this, so the attestation was already in the corpus; it simply
was not reaching the index.

**Orb only.** Device-level World ID attests a phone, not a person, and phones
are farmable. Counting device the same as orb would put the hole back while
looking like it had been closed.

**The coverage is partial and the number says so.** Only World carries World
ID, and the corpus spans three chains, so a wallet with no orb attestation
still keys a person by address. Every published epoch therefore carries
`verifiedPeople` beside `personCount`, and the ratio between them is how much
of the Sybil floor is load-bearing. An epoch where they are far apart is an
epoch whose floors are softer than they look, and nobody should have to infer
that.

---

## Cost to move

Published beside every value.

Because the aggregate is a weighted geometric mean, moving the log mean by one
percent means controlling share `s` where `s · ln(2.0) = 0.01` — the ceiling is
2.0 because the band rejects anything above it. That share of total expenditure,
times the per-item people floor, is what an attack costs.

**A market whose open interest exceeds that number should not be opened.** An
integrity rule nobody prices is a decoration, and this is the line that turns
the table above into something checkable rather than something asserted.

---

## What is published, and why all of it

At epoch close:

```
value        the change, in basis points
leavesRoot   Merkle root over the observations
leavesCID    IPFS CID of the complete leaf set
rulesHash    this document and its parameters, committed at open
personCount  distinct people, as a count
verifiedPeople  of those, how many are an orb-verified human
```

**The leaf set, not just the root.** A Merkle root proves an observation was
included. The attack on an index is not insertion, it is omission: drop the
observations on the wrong side, publish an honest aggregate of what remains,
and the root is valid, the rules hash matches and the bond is safe. Only the
complete input set makes exclusion provable.

**Leaves carry no identity.** A leaf is a price, a shop and a date — not
personal data. The per-person cap is enforced upstream and what gets committed
is the *count* of people, not a list of pseudonyms somebody can correlate
against a wallet later. Verifiability and privacy stop fighting once identity
is removed rather than obscured.

**And that has a price, which is easy not to mention.** A challenger who
fetches the leaf set can recompute the matching, the trim, the ratio clamps and
the aggregation — but they **cannot verify the per-person cap**, because the
leaves do not say who. They have to take `personCount` and `verifiedPeople` on
the publisher's word, backed by the bond rather than by arithmetic.

Publishing salted pseudonyms would make the cap checkable. It would also
publish how many receipts each person uploads, which for a small country series
is close to publishing their shopping frequency. The trade taken here is
privacy over that one check; the bond and the challenge window are what stand
behind the part that cannot be recomputed. Anyone who thinks that is the wrong
trade is disagreeing with a decision, not finding a bug.

---

## How to check a published number

1. Read `rulesHash` from the epoch record and confirm it matches this document.
2. Fetch `leavesCID` from IPFS.
3. Confirm the Merkle root over those leaves equals `leavesRoot`.
4. Run the pipeline in `apps/api/src/lib/matched-index/` over them.
5. If the answer differs, `dispute()` within the challenge window.

Step 4 is the one that has to be reproducible bit for bit, and the test suite
asserts exactly that against hand-computed fixtures. If it ever stops being
reproducible, the oracle is decorative and the bond is securing nothing.

---

## What this does not claim

It does not claim to be better than a statistical agency's CPI. An agency has
a fixed basket, quality adjustment, controlled outlet sampling and decades of
methodology; this has none of that.

What it has is coverage of places where the official number is slow, or
politically exposed, or both — and where there is no online price data to
scrape either, because the groceries are not bought from a website. A paper
receipt from a physical shop is the only way to observe that price at all.

That is the claim. Not *better measured*, but *measured where nothing else
reaches*.
