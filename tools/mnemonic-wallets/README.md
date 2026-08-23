# tools/mnemonic-wallets

Derive Midnight addresses from a BIP-39 mnemonic, using the **same HD derivation Lace uses**.

Lace imports a wallet from a mnemonic, never from a raw hex seed. Everything else in this repo
(`fund-wallet.sh`, `verify-wallets.sh`, the `fund` compose service) speaks to
`midnight-node-toolkit`, which only takes `--seed <hex>`. This tool is the bridge: it turns a
mnemonic into the seed and the four address forms, so `wallets/wallets.json` can promise "type
this phrase into Lace and the wallet is already funded" and have that be checkable.

Everything here is **offline and deterministic** — no chain, no network, no state. The same
mnemonic always produces the same addresses.

## Run it

Docker only (no host Node needed):

```bash
./tools/mnemonic-wallets/derive.sh                              # every entry in mnemonics.json
./tools/mnemonic-wallets/derive.sh --json
./tools/mnemonic-wallets/derive.sh --mnemonic "zoo zoo … vote"  # one ad-hoc phrase
./tools/mnemonic-wallets/derive.sh --check wallets/wallets.json # assert the manifest matches
./tools/mnemonic-wallets/derive.sh --list-repeated abandon      # valid "abandon x23 <w>" words
./tools/mnemonic-wallets/cross-check.sh                         # SDK vs toolkit, must agree
```

With Node ≥ 22 on the host (faster, identical output):

```bash
cd tools/mnemonic-wallets && npm ci && node derive.mjs --help
```

`derive.sh` builds a small local image (`midnight-2-offers/mnemonic-wallets:local`) holding
only the npm dependencies; the scripts themselves are mounted read-only from the repo, so
editing `derive.mjs` or `mnemonics.json` needs no rebuild. Remove the image with
`docker image rm midnight-2-offers/mnemonic-wallets:local`.

> Installing this dependency tree into a **bind mount** fails on macOS
> (`ENOTDIR … mkdir '/app/node_modules/@scure/bip32/node_modules/@noble'`), which is why the
> deps live in an image instead of in a mounted `node_modules`.

## The derivation

```
mnemonic ──BIP-39, EMPTY passphrase──► 64-byte master seed
         ──HDWallet.fromSeed = BIP-32 m/44'/2400'/<account>'/<role>'/<index>'──►
           account 0, index 0; roles Zswap(3), NightExternal(0), Dust(2)
         ──► ZswapSecretKeys.fromSeed          → shielded address
             createKeystore({kind:'schnorr'})  → unshielded address + userAddress
             DustSecretKey.fromSeed            → dust address
```

Pinned to the rc.4 stack's wallet SDK: `@midnightntwrk/wallet-sdk@2.0.0-beta.2` (the
`sourceRefs.midnight-wallet` tag in `$HOME/midnight-ref-ai/versions/v2.0.0-rc.4.json`) plus
`@midnightntwrk/ledger-v9@1.0.0-rc.3`. `package-lock.json` is committed and `npm ci` is used,
so a transitive patch release cannot silently change an address.

Sources for each step, if you need to re-derive the truth rather than trust this file:

| Fact | Where it is stated |
|---|---|
| `PURPOSE=44`, `COIN_TYPE=2400`, `Roles = {NightExternal:0, NightInternal:1, Dust:2, Zswap:3, EcdsaUnshielded:4}` | `@midnightntwrk/wallet-sdk-hd@3.1.0-beta.1` `dist/HDWallet.js` |
| mnemonic → seed is `mnemonicToSeedSync(mnemonic)` (empty passphrase), then `HDWallet.fromSeed` | `@midnight-ntwrk/testkit-js@5.0.0-beta.6` `WalletSeeds.fromMnemonic` / `deriveKeyForRole` |
| the unshielded keystore is `createKeystore({kind:'schnorr', secret}, networkId)` | same, `FluentWalletBuilder.build()` |
| the whole flow as a consumer uses it | `$HOME/midnight-ref-ai/midnight-local-dev/src/wallet.ts` (`buildWallet` → `withMnemonic`), `src/funding.ts` (`fundFromConfigFile`) |
| role selection with `selectRoles([Zswap, NightExternal, Dust]).deriveKeysAt(0)` | `$HOME/midnight-ref-ai/passport/demo/mn-passport-foundations/src/node/wallet.ts` |

### Two things that will silently give you a different, unfunded wallet

- **A BIP-39 passphrase.** Deliberately unsupported here. If Lace ever offers a passphrase
  field, leave it empty for these wallets.
- **A non-zero HD account or address index.** These addresses are account 0 / index 0, which
  is what a wallet shows right after an import. Switching accounts inside Lace produces
  different addresses that hold nothing.

## Choosing a mnemonic

A 24-word mnemonic carries an 8-bit checksum, so for any repeated word only a handful of final
words are valid. `--list-repeated <word> [wordCount]` enumerates them:

| Pattern | Valid final words |
|---|---|
| `abandon` ×23 + … | `art`, `diesel`, `false`, `kite`, `organ`, `ready`, `surface`, `trouble` |
| `zoo` ×23 + … | `buddy`, `cash`, `gap`, `leaf`, `move`, `party`, `sudden`, `vote` |
| `abandon` ×11 + … (12 words) | 128 of them, starting `about`, `actual`, `age`, `alpha` |

`mnemonics.json` picks `abandon ×23 diesel` (Midnight's own `TEST_MNEMONIC`, prefunded at
genesis), `abandon ×23 art` and `zoo ×23 vote` — the last two have precedent in
`$HOME/midnight-ref-ai/midnight-local-dev/accounts.example.json`.

## Adding a mnemonic wallet

1. Add it to `mnemonics.json` (`derive.sh --list-repeated <word>` to find a valid phrase).
2. `./tools/mnemonic-wallets/derive.sh --json` and paste `masterSeed` + `addresses` into
   `wallets/wallets.json` as a new entry with `"funding": "mnemonic"`.
3. `./tools/mnemonic-wallets/derive.sh --check wallets/wallets.json` — must pass.
4. `./tools/mnemonic-wallets/cross-check.sh` — must pass (SDK and toolkit agree).
5. `./scripts/fund-wallet.sh --all-demo` funds it on a running stack; `./scripts/verify-wallets.sh
   --include-script-funded` asserts it can pay a fee.

**Every mnemonic in here is a public, well-known dev phrase.** They control value only on a
throwaway local `undeployed` chain. Never reuse one anywhere real.
