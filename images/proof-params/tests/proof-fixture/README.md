# Real-proof fixture

One representative **real** proof per proof-server variant, computed offline from the shared
proof-data cache and nothing else.

## Why a Zswap output

The standard Zswap lane's proving key (`zswap/9/output.prover`) is part of the reviewed
generation. The proof server resolves it from `MIDNIGHT_PP` using the `key_location`
string carried inside the proof preimage, so the request sends
`option(proving-data) = None` — the last two bytes of the `/prove` body are `00 00` and
the harness asserts that. There is therefore **no prover key anywhere in this test**, which
makes a successful proof a direct measurement of the cache.

A Zswap *output* also needs no Merkle path or chain state, which is what keeps the whole
fixture to a handful of library calls. A Zswap *input* would need a qualified coin from
real chain data and would drag in the indexer.

Not used, by design: wallet, node, indexer, contract compilation, deployment, business flow.

## Negative control

A passing proof alone does not prove the key came from the cache. `run-gate.sh` therefore
sends the identical request to a proof server with an **empty** `MIDNIGHT_PP` and requires
it to fail. That server logs:

```
Missing zero-knowledge proving key for Zswap outputs. Attempting to download from the
host https://srs.midnight.network/ ...
```

and then gives up (the network is internal). The real readers, mounted on the populated
generation, never emit that line — which is the positive/negative pair behind the
"zero origin request" claim.

## Scope limit — ZKIR version

This exercises the standard v1/v2 lane on **both** builds. It is a genuine ZKIR-v2 proof
on the plain server. It is **not** a ZKIR-v3 proof on the experimental server: a v3 proof
needs a Compact contract circuit compiled with `zkir-v3`, and contract proving keys are
by design never in the shared cache (FR-013 scopes the cache to SRS + Ledger-static only),
so such a request must carry its own `proving-data`.

That is exactly what the sibling fixture [`../zkir-fixture/`](../zkir-fixture/README.md)
does, so the gap this section used to describe is closed: it compiles one minimal contract
with both backends and proves one circuit per variant, with the plain server's refusal of
the v3 artifact as the control. This fixture keeps the complementary half — the only proof
whose key comes **entirely** from the cache.

## Pins

- `@midnightntwrk/ledger-v9@1.0.0-rc.3` (note: the npm scope has no hyphen), locked by
  integrity hash in `package-lock.json`, installed with `npm ci --ignore-scripts`.
- Node image `docker.io/library/node@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96`
  (Node 22.23.2 / npm 10.9.8) — the same pin the audited forge proof gate used.

Dependencies are installed on the egress network; the proof itself runs on the internal,
no-egress network.
