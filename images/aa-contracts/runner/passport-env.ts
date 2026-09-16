// passport-env.ts — translate this repository's MIDNIGHT_* compose variables into the
// names the Passport fork's client reads, BEFORE that client is imported.
//
// IMPORT THIS FIRST, ALWAYS. `/aa/passport/src/node/wallet.ts` reads its endpoints at
// MODULE EVALUATION time (`const CONFIG = { ... process.env ... }`, then `setNetworkId`),
// so a variable set after that import has no effect at all. ESM evaluates the modules a
// file imports in the order the import statements appear, so
//
//     import './passport-env.ts';
//     import { createWallet } from '../passport/src/node/wallet.ts';
//
// is load-bearing ordering, not style.
//
// THE PROOF-SERVER SPLIT IS THE POINT OF THIS FILE. The stack runs TWO proof servers and
// they are different programs, not two tags (compose/aa.yml documents the executable
// hashes): the PLAIN one proves the standard lane — the wallet's own zswap/dust pieces
// while it balances — and the EXPERIMENTAL one proves calls against verifier-key[v7]
// artifacts, which is what `--feature-zkir-v3` makes every Passport circuit. The fork's
// client has ONE proof-server URL because on its own localnet one server does both, so:
//
//   * MIDNIGHT_PROOF_SERVER_URL is pointed at the PLAIN server, which is what the wallet
//     facade is built with (`provingServerUrl`);
//   * `providersFor()` in ./passport.ts REPLACES the returned `proofProvider` with one
//     aimed at the experimental server, which is what every contract call is proved by.
//
// Getting this backwards does not fail at start-up. It fails minutes into the first
// proof, with a server-side error about a verifier key it cannot read.

const set = (name: string, value: string | undefined): void => {
  if (value && !process.env[name]) process.env[name] = value;
};

// The fork selects a NETWORK by name and then lets every field be overridden. We always
// override every field, so the name only decides the fallbacks.
set('MIDNIGHT_NETWORK', 'local');
set('MIDNIGHT_NETWORK_ID', process.env['MIDNIGHT_NETWORK_ID'] ?? 'undeployed');
set('MIDNIGHT_NODE_URL', process.env['MIDNIGHT_NODE_HTTP']);
set('INDEXER_URL', process.env['MIDNIGHT_INDEXER_HTTP']);
set('INDEXER_WS_URL', process.env['MIDNIGHT_INDEXER_WS']);

/** The EXPERIMENTAL server — every contract call in this process is proved here. */
export const CONTRACT_PROOF_SERVER =
  process.env['MIDNIGHT_PROOF_SERVER_URL'] ?? 'http://aa-proof-server:6300';

/** The PLAIN server — the wallet facade's own pieces. Falls back to the contract server
 *  so a single-proof-server host (the fork's own localnet) still works unconfigured. */
export const WALLET_PROOF_SERVER =
  process.env['AA_WALLET_PROOF_SERVER_URL'] ?? CONTRACT_PROOF_SERVER;

// What the fork's module-level CONFIG will pick up: the WALLET's server.
process.env['MIDNIGHT_PROOF_SERVER_URL'] = WALLET_PROOF_SERVER;

// The compiled artefacts. The fork's default is `<src/node>/../../contracts/managed`,
// which is exactly where the image puts them, so this is belt and braces — and it is also
// the knob (Q37) that lets an operator point a long run at an immutable snapshot.
set('MIDNIGHT_MANAGED_PATH', '/aa/passport/contracts/managed');

// A localnet block is fast and a fee estimate made too far ahead is refused by the node's
// time-to-dismiss rule (Malformed(FeeCalculation(OutsideTimeToDismiss))). The fork's own
// defaults are right for a localnet; they are named here so an operator can see them.
set('TX_TTL_MS', '60000');
set('DUST_FEE_TIMEOUT_MS', '600000');

export const NETWORK_ID = process.env['MIDNIGHT_NETWORK_ID'] ?? 'undeployed';
