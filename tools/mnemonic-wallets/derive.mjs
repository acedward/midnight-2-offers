#!/usr/bin/env node
//
// Derive Midnight addresses from a BIP-39 mnemonic, using the SAME derivation Lace uses.
//
// Why this tool exists: Lace imports a wallet from a mnemonic, never from a raw hex seed. To
// hand a demo user a mnemonic and promise them a prefunded wallet, we have to know which
// address that mnemonic produces — and we have to know it offline, before any chain exists.
//
// The derivation, all of it (see the master plan's T2.6 findings for the sources):
//
//   mnemonic --BIP-39, empty passphrase--> 64-byte master seed
//            --HDWallet.fromSeed = BIP-32 m/44'/2400'/<account>'/<role>'/<index>'-->
//              account 0, index 0, roles Zswap(3) / NightExternal(0) / Dust(2)
//            --> ZswapSecretKeys.fromSeed        -> shielded address
//                createKeystore({kind:'schnorr'}) -> unshielded address + userAddress
//                DustSecretKey.fromSeed          -> dust address
//
// Authoritative references for each step:
//   * `@midnightntwrk/wallet-sdk-hd@3.1.0-beta.1` dist/HDWallet.js — PURPOSE=44,
//     COIN_TYPE=2400, Roles = {NightExternal:0, NightInternal:1, Dust:2, Zswap:3,
//     EcdsaUnshielded:4}. HDWallet exposes only fromSeed; mnemonic->seed is the caller's job.
//   * `@midnight-ntwrk/testkit-js@5.0.0-beta.6` — `WalletSeeds.fromMnemonic` is
//     `Buffer.from(mnemonicToSeedSync(mnemonic)).toString('hex')` then `HDWallet.fromSeed`,
//     and `FluentWalletBuilder.build()` wraps the NightExternal key as
//     `createKeystore({kind:'schnorr', secret}, networkId)`. This is the flow that
//     $HOME/midnight-ref-ai/midnight-local-dev/src/wallet.ts drives via `withMnemonic`.
//
// The output is cross-checkable against `midnight-node-toolkit show-address --seed <master
// seed hex>`, which is an offline command — see ./cross-check.sh. They have been verified to
// agree on every address form, which is what lets the rest of this repo keep using the
// toolkit for funding while still speaking Lace's language here.
//
// Deterministic and offline: no chain, no network, no state. Same mnemonic -> same addresses,
// forever.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

import {
  DustAddress,
  HDWallet,
  MidnightBech32m,
  Roles,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  createKeystore,
  validateMnemonic,
} from '@midnightntwrk/wallet-sdk';
import { DustSecretKey, ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import { mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MNEMONICS = resolve(HERE, 'mnemonics.json');

// ── derivation ───────────────────────────────────────────────────────────────

/**
 * Every address form a Midnight wallet has, for one mnemonic.
 *
 * `account` and `index` are exposed because they are part of the derivation path and Lace
 * shows account 0 / index 0 by default; a wallet imported into Lace and then switched to
 * another account will NOT match these addresses.
 */
export function deriveFromMnemonic(mnemonic, networkId = 'undeployed', account = 0, index = 0) {
  const normalized = mnemonic.trim().replace(/\s+/g, ' ');
  if (!validateMnemonic(normalized)) {
    throw new Error(`not a valid BIP-39 mnemonic (wordlist or checksum): "${normalized}"`);
  }

  // BIP-39 with an EMPTY passphrase. A passphrase would change every address below; Lace's
  // import has no passphrase field for these dev wallets, so empty is the only sane choice.
  const masterSeed = Buffer.from(mnemonicToSeedSync(normalized));

  const hd = HDWallet.fromSeed(masterSeed);
  if (hd.type !== 'seedOk') throw new Error(`HDWallet.fromSeed failed: ${hd.type}`);

  const derived = hd.hdWallet
    .selectAccount(account)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(index);
  if (derived.type !== 'keysDerived') throw new Error(`key derivation failed: ${derived.type}`);
  const keys = derived.keys;

  // 'schnorr' is what testkit-js/FluentWalletBuilder uses for the NightExternal role.
  // Roles.EcdsaUnshielded exists for the 'ecdsa' variant and is a different address.
  const keystore = createKeystore({ kind: 'schnorr', secret: keys[Roles.NightExternal] }, networkId);

  const zswap = ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const shieldedAddress = new ShieldedAddress(
    ShieldedCoinPublicKey.fromHexString(zswap.coinPublicKey),
    ShieldedEncryptionPublicKey.fromHexString(zswap.encryptionPublicKey),
  );

  const dustSecretKey = DustSecretKey.fromSeed(keys[Roles.Dust]);

  const out = {
    mnemonic: normalized,
    words: normalized.split(' ').length,
    networkId,
    account,
    index,
    masterSeed: masterSeed.toString('hex'),
    addresses: {
      unshielded: keystore.getBech32Address().asString(),
      shielded: MidnightBech32m.encode(networkId, shieldedAddress).asString(),
      dust: DustAddress.encodePublicKey(networkId, dustSecretKey.publicKey),
      userAddress: keystore.getAddress(),
    },
  };

  // Keys are secrets; wipe what the SDK lets us wipe rather than leaving it live in the heap.
  hd.hdWallet.clear();
  zswap.clear?.();

  return out;
}

// ── repeated-word mnemonic enumeration ───────────────────────────────────────
//
// A 24-word mnemonic encodes 256 bits of entropy plus an 8-bit checksum, so for any repeated
// word only a handful of final words make the checksum valid. This lists them, which is how
// the mnemonics in mnemonics.json were chosen: maximum repetition = minimum typing in the
// Lace import UI.
function listRepeated(word, words) {
  if (!english.includes(word)) throw new Error(`"${word}" is not in the BIP-39 English wordlist`);
  const valid = [];
  for (const last of english) {
    const candidate = [...Array(words - 1).fill(word), last].join(' ');
    if (validateMnemonic(candidate)) valid.push(last);
  }
  return valid;
}

// ── cli ──────────────────────────────────────────────────────────────────────

function usage() {
  console.log(`Derive Midnight addresses from BIP-39 mnemonics (offline, deterministic).

Usage:
  node derive.mjs [options]                       derive every entry in mnemonics.json
  node derive.mjs --mnemonic "<words...>"         derive one ad-hoc mnemonic
  node derive.mjs --check <wallets.json>          re-derive and compare against a wallets.json
  node derive.mjs --list-repeated <word> [words]  valid "<word> xN <last>" mnemonics

Options:
  --network <id>     network id for the bech32 prefixes. Default "undeployed".
  --account <n>      HD account. Default 0 — what Lace shows on import.
  --index <n>        HD key index. Default 0.
  --json             machine-readable output.
  --mnemonics <path> mnemonic list to read. Default ./mnemonics.json.
  -h, --help         this text.

Notes:
  * Addresses depend on mnemonic + networkId + account + index, and on nothing else — no
    chain, no state. They survive a ./down.sh -v reset.
  * A BIP-39 passphrase is NOT supported, deliberately: the demo wallets have none, and a
    passphrase would silently produce a different (unfunded) wallet.
  * --check exits non-zero on any mismatch, so it works as a test.`);
}

function parseArgs(argv) {
  const opts = {
    network: 'undeployed',
    account: 0,
    index: 0,
    json: false,
    mnemonics: DEFAULT_MNEMONICS,
    one: null,
    check: null,
    listRepeated: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (name) => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${name} needs a value`);
      return v;
    };
    switch (a) {
      case '--network': opts.network = need(a); break;
      case '--account': opts.account = Number(need(a)); break;
      case '--index': opts.index = Number(need(a)); break;
      case '--json': opts.json = true; break;
      case '--mnemonics': opts.mnemonics = resolve(need(a)); break;
      case '--mnemonic': opts.one = need(a); break;
      case '--check': opts.check = resolve(need(a)); break;
      case '--list-repeated': {
        const word = need(a);
        // The optional word count is a bare number, so only consume it if it looks like one.
        let words = 24;
        if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) words = Number(argv[++i]);
        opts.listRepeated = { word, words };
        break;
      }
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

function readMnemonicList(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const entries = parsed.mnemonics ?? parsed.accounts;
  if (!Array.isArray(entries)) {
    throw new Error(`${path}: expected a "mnemonics" (or "accounts") array`);
  }
  return entries;
}

function printHuman(rows) {
  for (const row of rows) {
    console.log(`### ${row.name ?? row.addresses.unshielded}`);
    if (row.role) console.log(`  role        ${row.role}`);
    console.log(`  mnemonic    ${row.mnemonic}`);
    console.log(`  words       ${row.words}   (BIP-39 checksum valid)`);
    console.log(`  path        m/44'/2400'/${row.account}'/<role>'/${row.index}'  network=${row.networkId}`);
    console.log(`  masterSeed  ${row.masterSeed}`);
    console.log(`  unshielded  ${row.addresses.unshielded}   <- the Lace receive address`);
    console.log(`  shielded    ${row.addresses.shielded}`);
    console.log(`  dust        ${row.addresses.dust}`);
    console.log(`  userAddress ${row.addresses.userAddress}`);
    console.log();
  }
}

// --check: re-derive every wallets.json entry that carries a mnemonic and compare the seed
// and all four address forms. This is the regression test that catches (a) a hand-edit that
// drifted, (b) an SDK bump that changed the derivation, and (c) a mnemonic typo.
function runCheck(path, opts) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const networkId = opts.network === 'undeployed' && manifest.networkId ? manifest.networkId : opts.network;
  const withMnemonic = (manifest.wallets ?? []).filter((w) => typeof w.mnemonic === 'string' && w.mnemonic);

  if (withMnemonic.length === 0) {
    console.error(`no wallets with a "mnemonic" field in ${path}`);
    return 1;
  }

  let failures = 0;
  for (const wallet of withMnemonic) {
    const account = wallet.derivation?.account ?? opts.account;
    const index = wallet.derivation?.index ?? opts.index;
    const derived = deriveFromMnemonic(wallet.mnemonic, networkId, account, index);
    const problems = [];

    if (wallet.seed && wallet.seed !== derived.masterSeed) {
      problems.push(`seed: recorded ${wallet.seed} != derived ${derived.masterSeed}`);
    }
    for (const [kind, value] of Object.entries(derived.addresses)) {
      const recorded = wallet.addresses?.[kind];
      if (recorded !== undefined && recorded !== value) {
        problems.push(`${kind}: recorded ${recorded} != derived ${value}`);
      }
    }

    if (problems.length) {
      failures++;
      console.error(`FAIL ${wallet.name}`);
      for (const p of problems) console.error(`     ${p}`);
    } else {
      console.log(`ok   ${wallet.name}  ${derived.addresses.unshielded}`);
    }
  }

  console.log();
  if (failures) {
    console.error(`${failures} of ${withMnemonic.length} mnemonic wallet(s) do NOT match their recorded derivation`);
    return 1;
  }
  console.log(`all ${withMnemonic.length} mnemonic wallet(s) match their recorded derivation (network ${networkId})`);
  return 0;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}\n`);
    usage();
    process.exit(2);
  }

  if (opts.help) { usage(); return 0; }

  if (opts.listRepeated) {
    const { word, words } = opts.listRepeated;
    const valid = listRepeated(word, words);
    if (opts.json) {
      console.log(JSON.stringify({ word, words, validLastWords: valid }, null, 2));
    } else {
      console.log(`"${word}" x${words - 1} + <last word>: ${valid.length} valid mnemonic(s)`);
      console.log(valid.join(' '));
    }
    return 0;
  }

  if (opts.check) return runCheck(opts.check, opts);

  const entries = opts.one
    ? [{ name: null, mnemonic: opts.one }]
    : readMnemonicList(opts.mnemonics);

  const rows = entries.map((e) => ({
    name: e.name,
    role: e.role,
    ...deriveFromMnemonic(e.mnemonic, opts.network, e.account ?? opts.account, e.index ?? opts.index),
  }));

  if (opts.json) console.log(JSON.stringify(rows, null, 2));
  else printHuman(rows);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
