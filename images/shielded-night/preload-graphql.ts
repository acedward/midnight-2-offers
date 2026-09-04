// Preloaded by entrypoint-deploy.sh before scripts/deploy.ts, and by nothing else.
//
// THE CRASH THIS PREVENTS, measured on this stack 2026-09-04:
//
//   TypeError: require() async module "/app/node_modules/graphql/index.mjs" is unsupported.
//              use "await import()" instead.
//     at /app/node_modules/graphql-tag/lib/graphql-tag.umd.js:2:76
//   [shielded-night-deploy] FATAL: scripts/deploy.ts failed
//
// graphql@17's exports map lists Bun's "bun" condition before "require" in every branch, and
// both point at an ESM-only `.mjs`. So when something in the deploy's import graph reaches
// `graphql` first through a plain CJS `require()` — graphql-tag's UMD bundle, pulled in by
// @apollo/client/core — Bun refuses to require() an async ES module and the process dies before
// a single wallet is built.
//
// Importing `graphql` FIRST resolves it through Bun's ESM path, which handles an async module
// natively, and caches that resolution; the later `require()` inside the UMD wrapper then reuses
// the cache instead of re-resolving through the broken exports-map ordering.
//
// This is UPSTREAM's own remedy, not an invention here: shielded-night `30af63f` applies exactly
// this to `scripts/verify-deployment.ts`, with the mechanism written out in its commit message.
// That commit states deploy.ts is unaffected — on this host it is affected INTERMITTENTLY, which
// is worse than deterministically, because a green bring-up proves nothing about the next one.
// See the plan's questions file, Q30.
//
// Nothing upstream is modified: this file sits beside the tree and is passed with
// `bun run --preload`, the same way entrypoint-price-feed.sh normalises an environment without
// editing the program it wraps.
import "graphql";
