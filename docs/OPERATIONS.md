# Operations — waits, verification, teardown, CI

The operational details the README summarizes: what `up.sh` actually waits on and why the
container healthchecks are not enough, what `verify.sh` proves, what a full reset removes,
and how the CI harness stays safe on a shared machine.

## What `up.sh` waits on

`up.sh` returns only when the stack is genuinely usable, which is stricter than "docker says
healthy":

| Service | What is waited on | Why not the healthcheck |
|---|---|---|
| node | RPC answers `chain_getBlockHash[1]`, **and** finalized height ≥ 1 | The node answers RPC several blocks before finality moves off genesis, and in that window the toolkit refuses to build transactions (`OnlyGenesisFinalized`) |
| indexer | GraphQL v4 answers a block query | Its container healthcheck only proves the supervisor is alive — the entrypoint touches the running-file *before* launching the indexer |
| proof-server | the port accepts a TCP connection | The image has no curl/wget, and its bash sits behind a per-tag `/nix/store/<hash>…` path |
| evm-rpc (`--with evm`) | `eth_chainId` answers over HTTP, **and** the WS port completes a `101 Switching Protocols` handshake | A TCP probe of a *published* port proves nothing: docker's port proxy accepts the connection before it dials the container, so `nc -z` reports a working endpoint that refuses every client |

## Verifying and tearing down

```bash
./verify.sh              # node finality + indexer GraphQL + proof-server + wallets (+ evm, celestia if up)
./verify.sh --core-only  # skip the wallet checks (each spawns a toolkit container) and both profiles
./verify.sh --evm        # require the evm section — fail if the profile is not up
./verify.sh --no-evm     # skip the evm section even when it is up
./verify.sh --celestia   # require the celestia section — fail if the profile is not up
./verify.sh --no-celestia # skip the celestia section even when it is up
./down.sh                # stop, keep the chain — ./up.sh resumes it
./down.sh -v             # FULL RESET: wipes node, indexer, evm-postgres, celestia and cache volumes
```

Each optional section runs automatically when that profile's containers exist, so `./verify.sh`
needs no argument either way. `./scripts/verify-evm.sh` and `./scripts/verify-celestia.sh` run
them alone (`--quick` skips the slow check in each: `newHeads` delivery, and the blob round trip).

`down.sh -v` wipes the node volume and the indexer volume **together**, and that is a
correctness requirement rather than tidiness: a ledger v8→v9 chain cannot be upgraded in
place, so a fresh node genesis paired with a surviving indexer database gives you an indexer
serving a chain that no longer exists. The toolkit's fetch cache and the umbra-evm Postgres volume
go with them for the same reason — every one of them holds state keyed to one specific genesis.

`down.sh` always passes **every** fragment in `compose/`, so a profile you brought up earlier is
torn down even if you do not name it now. Every volume is declared in a fragment for the same
reason: only a compose-created volume carries the project label that the "nothing left behind"
count filters on.

### Full reset

`./down.sh -v` **is** the full reset — there is no second cleanup step to remember, and no state
outside what it removes:

```bash
./down.sh -v && ./up.sh --all        # brand-new genesis, brand-new everything
```

What it removes, and what each piece of state is keyed to:

| State | Where it lives | Keyed to |
|---|---|---|
| chain data | volume `<project>_node-data` | the genesis it was created with |
| indexed blocks | volume `<project>_indexer-data` | that same genesis |
| eth balances, logs, cursors | volume `<project>_evm-postgres-data` | that same genesis |
| Celestia chain + validator keyring + bridge store | volume `<project>_celestia-data` | its own Celestia genesis |
| the DA auth token + handoff file | volume `<project>_celestia-auth` | the bridge store above |
| toolkit fetch/ledger cache | host directory `.cache/<project>/` | that same Midnight genesis |

They must go together. A fresh node genesis beside a surviving indexer database gives you an
indexer serving a chain that no longer exists; a surviving toolkit cache makes the next funding
run fail in a way that looks nothing like "stale cache"; and an offer spans **both** chains, so a
Celestia history describing offers against a Midnight genesis that no longer exists is worse than
no history at all. The cache is the one piece compose cannot remove for you (it is a host
directory, not a volume, because a `docker run` volume carries no project label and therefore
escapes `docker compose down -v` entirely) — `down.sh` deletes it explicitly.

Nothing survives a reset except the things derived from `seed + networkId`: every address in
`wallets/wallets.json` stays valid, and `lace-test` is funded again at the new genesis. So a
reset costs you a `fund-wallet.sh --all-demo`, nothing more.

If a teardown ever reports leftovers, `./down.sh -v` printed the exact filter to inspect them
with; the same assertion (plus a name-prefix sweep for unlabelled volumes) is what
`scripts/ci-check.sh` fails on.

## Running two stacks at once

Every host port and the compose project name come from the env file, and no service addresses
another by a host port — they talk over the compose network on fixed container ports. So a
second, fully independent stack is just a second env file:

```bash
./scripts/pick-ports.sh > .env.test   # random project name + a free port block >= 10100
ENV_FILE=.env.test ./up.sh
ENV_FILE=.env.test ./verify.sh
ENV_FILE=.env.test ./down.sh -v       # leaves the other stack untouched
```

## One-command check (CI)

```bash
./scripts/ci-check.sh                 # the whole chain, on ports nothing else is using
./scripts/ci-check.sh --core-only     # skip the evm and offerfiles profiles (no image builds)
./scripts/ci-check.sh --no-fund       # genesis wallets only
./scripts/ci-check.sh --keep          # on failure, leave the stack up for inspection
```

It generates its own env file (so it never touches your `.env` or the default ports), brings up
the profiles, funds the five non-genesis wallets, runs `verify.sh` **and**
`verify-wallets.sh --include-script-funded`, then tears everything down and asserts that nothing
survived. Exit 0 means both halves of that: the stack worked, and the machine is clean.

Three details that make it safe to run on a shared box, and that are worth copying if you write
your own harness:

- **It tears down on every exit path** — failure, `Ctrl-C`, `SIGTERM`. `up.sh` deliberately
  leaves a failed stack running so a human can look at it; that is the wrong default for CI, so
  the teardown lives in an `EXIT` trap.
- **The teardown is asserted, not assumed.** Containers, networks and volumes are counted by
  compose-project label *and* by name prefix. A volume created outside compose has no project
  label at all, so a label-only count once reported a clean teardown while state survived.
- **`verify.sh` alone would not prove the funding worked.** Its wallet section checks the
  *genesis* wallets, which are funded whether or not anything ran. Asserting the script-funded
  ones needs the explicit `--include-script-funded`, which is why `ci-check.sh` runs both.
