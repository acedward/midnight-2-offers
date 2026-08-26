# Wallets — the full story

The README keeps the funded-wallet table; this file keeps everything else: the Lace imports,
the mnemonic↔seed derivation and its cross-checks, funding mechanics, and the token-model
gotchas.

## Wallets

`wallets/wallets.json` is the manifest: every wallet this stack knows about, its seed, all
its address forms, and whether it is funded by genesis or by the funding script. The
addresses there are derived from `seed + networkId` only, so they stay valid across a
`./down.sh -v` reset.

### Prefunded at genesis — nothing to run

`CFG_PRESET=dev` genesis funds these four wallets **and registers their DUST addresses**, so
they can pay fees from the first block. Verified on node 2.0.0-rc.4: 5 unshielded NIGHT UTXOs
of 50,000,000 NIGHT each (250,000,000 NIGHT total, i.e. 250,000,000,000,000 stars), 5 DUST
UTXOs, DUST balance 1.25 × 10²⁴ specks.

| Name | Seed | Role |
|---|---|---|
| `genesis-1` | `0x…0001` (32 bytes) | faucet — the default funding source for `fund-wallet.sh` |
| `genesis-2` | `0x…0002` (32 bytes) | reserved as the offer-files batcher wallet, for when that profile lands |
| `genesis-3` | `0x…0003` (32 bytes) | spare prefunded wallet / second demo actor |
| `lace-test` | `a51c86de…0593ec9` (64 bytes, 128 hex chars) | Midnight's own canonical test wallet — **importable into Lace from a mnemonic, see below** |

Two things that are easy to get wrong here:

- **`0x…0004` is NOT funded.** The seed list in midnight-node's
  `scripts/genesis_wallets_test.sh` includes a fourth `0x…0004` seed, but on the published
  `CFG_PRESET=dev` genesis that wallet is empty (0 UTXOs, 0 DUST). Only 01/02/03 and the
  Lace seed are funded.
- **The Lace seed is 128 hex characters**, not 64. It is a 64-byte seed and the toolkit
  accepts it as-is wherever a `--seed` is taken. It is 64 bytes because it is a **BIP-39
  master seed**, not an arbitrary secret — which is exactly what makes it importable into
  Lace (see [Import into Lace](#import-into-lace)).

### Funded by one command, not by genesis

The other three entries start empty and are brought to 10,000,000 NIGHT + spendable DUST by
`./scripts/fund-wallet.sh --all-demo`. They exist so a demo can move value between named
actors without touching the faucet wallet, and **all three are Lace-importable**: each one is
addressed by a BIP-39 mnemonic, so you can type it into a wallet GUI, while its 64-byte master
seed is what you paste into the scripts.

| Name | Mnemonic | BIP-39 master seed (paste into scripts) |
|---|---|---|
| `demo-alice` | `alpha` ×23 + `avoid` | `0a4f358d27c85cc3063c73fe002e9f933722aad5bc009799805946cc5a9e7272f249189587fe0254c6d18b5bc1a24f60617bc62f07c5b57343b0fddf8e680d96` |
| `demo-bob` | `boss` ×23 + `burst` | `1ce2d940e5a46775697fa7878627fbd689b5e6e73c7e32b82ed01468b07534288f9b74cbcd116b75a3f854315accdf39f87d075bd74a23eaf4910d95e7629095` |
| `demo-carol` | `cactus` ×23 + `cherry` | `fc14ae819b1a9ace2304c5cf960596741fccd13522eda7718a2c82c61ab409c2c520ccabc898725c565d25b8b2d84f7117869c36391b1f68a54ea0d89a201090` |

The checksum word shares the actor's initial (a/b/c), so the phrase says whose wallet it is.
All three carry `funding: mnemonic`, which the tooling treats exactly like `fund-script`.

**Seed and phrase are the same wallet, in two formats.** Seeds get copy-pasted into scripts;
mnemonics get typed by hand into a GUI. The seed above is not an arbitrary secret — it is the
BIP-39 master seed of that phrase with an empty passphrase, which is what makes the toolkit
and Lace resolve to the same wallet. `tools/mnemonic-wallets/cross-check.sh` asserts it both
ways, and `./tools/mnemonic-wallets/derive.sh --check wallets/wallets.json` re-derives every
phrase and fails on any mismatch.

Seven wallets in total, then: four funded at genesis and three funded on demand. The
`funding` field is what drives the tooling — `fund-wallet.sh --all-demo` funds everything
that is not `genesis`, and `verify-wallets.sh` asserts the genesis ones by default and all
seven with `--include-script-funded`.

### Funding more wallets

```bash
# fund one wallet: NIGHT + DUST registration + wait until fees are payable
./scripts/fund-wallet.sh <seed-or-address>

# fund every wallets.json entry that is not genesis-funded (demo-alice/bob/carol,
# all funding="mnemonic")
./scripts/fund-wallet.sh --all-demo

# same thing as a one-shot compose service instead of a host script
docker compose --profile fund -f compose/core.yml run --rm fund

# assert the genesis wallets are funded and fee-capable
./scripts/verify-wallets.sh
./scripts/verify-wallets.sh --include-script-funded   # after funding the demo wallets
```

Pass a **seed** whenever you can. Given a seed the script does the whole job: sends NIGHT,
registers the DUST address, and waits for a spendable DUST UTXO. Given only an **address** it
can only send NIGHT — DUST registration is a transaction signed by the wallet's own key, so
the owner has to register before that wallet can pay a fee.

**Why the default amount is 10,000,000 NIGHT.** DUST accrues in proportion to the NIGHT
backing it, so the funded amount decides how soon the wallet can pay a fee — it is not about
the demo needing that much value. Measured on this stack: a wallet funded with **100 NIGHT**
gets its DUST UTXO immediately but still fails a transfer with
`Insufficient DUST (trying to spend 260838254857211, need 102111854857211 more)`, and would
need roughly 45 minutes of accrual to clear a single fee. Funded with **10,000,000 NIGHT** the
same wallet pays its fees as soon as the DUST UTXO appears. Lower `--amount` only if you are
prepared to wait.

## Import into Lace

Lace imports a wallet from a **mnemonic**, never from a raw hex seed, so the wallets below are
addressed by phrase. All four are one word repeated 23 times plus a checksum word, which
means they can be typed into Lace's import screen in well under a minute.

Point Lace at this stack first: its `undeployed` preset expects **node 9944, indexer 8088,
proof-server 6300**, which is what `.env.example` defaults to. If you moved the ports (or ran
`scripts/pick-ports.sh`), Lace will not find the stack.

| Wallet | Mnemonic | Funded by | Receive address (unshielded) |
|---|---|---|---|
| `lace-test` | `abandon` ×23 + `diesel` | **genesis — nothing to run** | `mn_addr_undeployed1nqhdatus5d6tvye57q854kdrs6ur2ytsl8yaygzfsdy2e3tvtmesdcgp8m` |
| `demo-alice` | `alpha` ×23 + `avoid` | `fund-wallet.sh --all-demo` | `mn_addr_undeployed14tjhxluvt773ry7hta5ysvhymjk6usyhlgauzt4al9t8lpe4gtzqvnj8gs` |
| `demo-bob` | `boss` ×23 + `burst` | `fund-wallet.sh --all-demo` | `mn_addr_undeployed1va25tg7d43rcftqeafs6dn3mvycut9zffq989my7p6c8kr0djl5shn25qj` |
| `demo-carol` | `cactus` ×23 + `cherry` | `fund-wallet.sh --all-demo` | `mn_addr_undeployed1ctfkn3nhju6f8p4t92ay0k30eswc4n9s60rjq2s3rkearf454tgqh6ckgy` |

"`abandon` ×23 + `diesel`" means the word `abandon` typed 23 times followed by `diesel` — 24
words total. `wallets/wallets.json` holds each phrase in full, along with the shielded, dust
and `userAddress` forms and the BIP-39 master seed.

### The same wallets as seeds

Type the phrase into Lace; paste the seed into `fund-wallet.sh`, `verify-wallets.sh` or the
toolkit. They address the identical wallet — the seed is the BIP-39 master seed of the phrase
(empty passphrase), which is why the toolkit and Lace agree on every address.

| Wallet | BIP-39 master seed (128 hex = 64 bytes) |
|---|---|
| `lace-test` | `a51c86de32d0791f7cffc3bdff1abd9bb54987f0ed5effc30c936dddbb9afd9d530c8db445e4f2d3ea42a321b260e022aadf05987c9a67ec7b6b6ca1d0593ec9` |
| `demo-alice` | `0a4f358d27c85cc3063c73fe002e9f933722aad5bc009799805946cc5a9e7272f249189587fe0254c6d18b5bc1a24f60617bc62f07c5b57343b0fddf8e680d96` |
| `demo-bob` | `1ce2d940e5a46775697fa7878627fbd689b5e6e73c7e32b82ed01468b07534288f9b74cbcd116b75a3f854315accdf39f87d075bd74a23eaf4910d95e7629095` |
| `demo-carol` | `fc14ae819b1a9ace2304c5cf960596741fccd13522eda7718a2c82c61ab409c2c520ccabc898725c565d25b8b2d84f7117869c36391b1f68a54ea0d89a201090` |

Re-derive any of them yourself — the phrase is the source of truth, the seed is cached in
`wallets/wallets.json`:

```bash
./tools/mnemonic-wallets/derive.sh --mnemonic "alpha alpha … avoid"
./tools/mnemonic-wallets/derive.sh --check wallets/wallets.json   # asserts all four
```

**Start with `lace-test`.** It is prefunded at genesis with 250,000,000 NIGHT and its DUST
address is registered from block zero, so it can pay fees immediately and survives a
`./down.sh -v` reset with no funding step. It is not a phrase we invented either: it is
Midnight's own canonical test wallet — `@midnight-ntwrk/testkit-js` defines exactly this
mnemonic as `TEST_MNEMONIC`, and midnight-node's Earthfile funds its seed at genesis with the
comment *"wallet-seed-3 is the wallet Lace uses for testing"*.

The other two are empty until you fund them, which is one command on a running stack:

```bash
./scripts/fund-wallet.sh --all-demo                    # 10,000,000 NIGHT + DUST each
./scripts/verify-wallets.sh --include-script-funded    # assert they can pay a fee
```

They exist so a two-party demo (make an offer with one wallet, take it with another) needs two
imports and no seed juggling.

### If Lace shows a different address

**Then the derivation differs, and that is a finding worth recording** — not something to work
around. Please note the address Lace shows, next to the one in the table, in the project's
findings log (`00001-demo-infra`, task T2.6) so the mismatch can be chased rather than
rediscovered. A wallet at a different address is simply unfunded, and an unfunded wallet in a
demo reads as "the stack is broken".

Before concluding that, rule out the three things that legitimately change the address:

- **A BIP-39 passphrase.** These wallets have none. Leave any passphrase field empty.
- **A different HD account or address index.** The table is account 0, address index 0 — what
  Lace shows immediately after an import. Switching accounts gives different, empty addresses.
- **A different network.** The addresses are `undeployed`; a Lace pointed at testnet or
  mainnet derives different prefixes from the same phrase.

What has already been checked, so it is not the likely culprit: the two independent
implementations this repo relies on agree exactly. `tools/mnemonic-wallets/` derives these
addresses with the **wallet SDK's** HD derivation (`@midnightntwrk/wallet-sdk@2.0.0-beta.2`,
BIP-39 → BIP-32 `m/44'/2400'/0'/<role>'/0'`), and `midnight-node-toolkit show-address` derives
them from the same master seed; every address form matches, for all three phrases, and
`lace-test`'s match the genesis wallet the chain actually funds. Re-run the proof any time,
offline and with the stack down:

```bash
./tools/mnemonic-wallets/derive.sh                          # show all three, in full
./tools/mnemonic-wallets/derive.sh --check wallets/wallets.json
./tools/mnemonic-wallets/cross-check.sh                     # wallet SDK vs toolkit
```

**Not yet confirmed against the Lace UI itself.** Nobody has typed these phrases into Lace and
compared what it displays — that step needs a human with the extension installed. Everything
up to Lace's own screen is verified; the last hop is not. See `tools/mnemonic-wallets/README.md`
for the derivation, its sources, and how to add more phrases.

## Token model gotchas

Distilled from `NIGHT-shielded-vs-unshielded-FINDINGS.md` in the reference checkout, and
confirmed against this stack.

- **`nativeToken()` returns *unshielded* NIGHT**, despite the name. `unshieldedToken()` is the
  same thing; shielded NIGHT is `shieldedToken()`.
- **Shielded and unshielded NIGHT share the same 32-zero-byte colour** and differ only by an
  enum tag (`Unshielded=0`, `Shielded=1`, `Dust=2`). You cannot tell them apart by colour, so
  filter the UTXO list by token type when you mean unshielded NIGHT.
- **Fees are paid in DUST, never in NIGHT.** `feeToken()` is `TokenType::Dust`.
- **DUST is generated by registered *unshielded* NIGHT UTXOs.** Registration
  (`register-dust-address`) respends the wallet's NIGHT UTXOs so they begin generating — which
  is why the funding script registers *after* sending NIGHT, not before.
- **Shielded NIGHT can neither pay fees nor be registered for DUST.** It is contract-spendable
  value only. `fund-wallet.sh --shielded-amount` exists for that purpose and warns accordingly.
- **DUST readiness is a non-empty `dust_utxos` list, not `dust-balance.total > 0`.** After a
  registration the balance figure moves before a spendable UTXO exists; a wallet with balance
  and no UTXO cannot pay anything. Both the funding script and `verify-wallets.sh` assert the
  UTXO.
- Units: 1 NIGHT = 10⁶ stars; 1 DUST = 10¹⁵ specks.
