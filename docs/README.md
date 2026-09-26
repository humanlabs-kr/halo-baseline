# docs

| | |
|---|---|
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | How the apps ship. |
| [`index-methodology.md`](./index-methodology.md) | What `rulesHash` commits to: every parameter behind a published index, in the order they are applied, and for each integrity rule the attack it stops. Read this before disputing a published value — it ends with the five steps to re-run one. |
| [`deployed.md`](./deployed.md) | Every address on Sepolia and the transaction hashes that prove each claim: the settlement lifecycle, two live v4 pools whose fees differ by 23x from the clock alone, and the ENS loop driven by a standards-compliant client. |
| [`open-decisions.md`](./open-decisions.md) | Eight choices that needed a person. Seven are decided and shipped, each keeping what it traded away; the last one is two facts about us that only a human has. |
| [`ens-gateway.md`](./ens-gateway.md) | The CCIP-Read gateway: what it refuses and why, the digest that breaks silently when two languages disagree about it, and one signing key per environment. |
| [`ens-sepolia-status.md`](./ens-sepolia-status.md) | Why `halo.eth` is not registered, with the trace. Nobody can register a `.eth` name on Sepolia right now — ENS's own controller is deauthorised on its registrar. Also: mainnet `halo.eth` belongs to someone else. |

The hedge contracts have their own README at
[`packages/hedge/README.md`](../packages/hedge/README.md), which leads with the
three design decisions that are invisible from the function signatures.
