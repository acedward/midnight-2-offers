# Operations — waits, verification, teardown, CI

The operational details the README summarizes: what `up.sh` actually waits on and why the
container healthchecks are not enough, what `verify.sh` proves, what a full reset removes,
and how the CI harness stays safe on a shared machine.


## Shipping console/runner changes

The AA console's page (`images/aa-contracts/console/`) and relay
(`images/aa-contracts/runner/`) are **baked into the aa images at build time** — a running
container serves whatever the image was built from, and a recreate resets any files copied in
by hand. After changing them, rebuild so the change is permanent on the stack:

```
./up.sh --with … --build        # rebuilds the local images, then brings the stack up
```

`docker cp … + docker restart` into the live console container is a dev-iteration shortcut
only; the next `--force-recreate`/`down`/`up` discards it.
## What `up.sh` waits on

`up.sh` returns only when the stack is genuinely usable, which is stricter than "docker says
healthy":

| Service | What is waited on | Why not the healthcheck |
|---|---|---|
| node | RPC answers `chain_getBlockHash[1]`, **and** finalized height ≥ 1 | The node answers RPC several blocks before finality moves off genesis, and in that window the toolkit refuses to build transactions (`OnlyGenesisFinalized`) |
| indexer | GraphQL v4 answers a block query | Its container healthcheck only proves the supervisor is alive — the entrypoint touches the running-file *before* launching the indexer |
| proof-server | the port accepts a TCP connection | The image has no curl/wget, and its bash sits behind a per-build `/nix/store/<hash>…` path. Compose has already gated it on the proof-data cache verifying, so reaching this point means the shared generation is active |
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
./down.sh -v             # FULL RESET: wipes every project volume — node, indexer, postgres,
                         #             celestia, toolkit cache AND the proof-data cache
```

Each optional section runs automatically when that profile's containers exist, so `./verify.sh`
needs no argument either way. `./scripts/verify-evm.sh` and `./scripts/verify-celestia.sh` run
them alone (`--quick` skips the slow check in each: `newHeads` delivery, and the blob round trip).

`down.sh -v` wipes the node volume and the indexer volume **together**, and that is a
correctness requirement rather than tidiness: a ledger v8→v9 chain cannot be upgraded in
place, so a fresh node genesis paired with a surviving indexer database gives you an indexer
serving a chain that no longer exists. The toolkit's fetch cache and the shared Postgres volume
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
| eth balances/logs/cursors (db `umbra`) **and** the offer book (db `offerfiles`) | volume `<project>_postgres-data` | that same genesis |
| the deployed offer-files contract address | volume `<project>_offerfiles-deploy` | that same genesis |
| the batcher's accepted-but-unsubmitted inputs | volume `<project>_offerfiles-batcher` | that same genesis |
| Celestia chain + validator keyring + bridge store | volume `<project>_celestia-data` | its own Celestia genesis |
| the DA auth token + handoff file | volume `<project>_celestia-auth` | the bridge store above |
| toolkit fetch/ledger cache | host directory `.cache/<project>/` | that same Midnight genesis |
| the verified proof-data generation | volume `<project>_proof-params` | **nothing** — see below |

The proof-data cache is the odd one out. Its contents are published SRS and Ledger-static
payloads that have nothing to do with this chain's genesis, so plain `./down.sh` keeps it and
the next bring-up reuses it for free. `-v` removes it anyway, because a project-wide wipe that
leaves something behind is not a wipe and the "nothing left behind" assertion would fail. The
only cost is one ~223 MB re-download (~60 s) the next time the stack comes up — and the proof
servers will not start until that download verifies, by design.

Everything else must go together. A fresh node genesis beside a surviving indexer database gives you an
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

## The `shielded-night` profile

```bash
./up.sh --with shielded-night      # core + this profile; nothing else is needed
./verify.sh --shielded-night       # REQUIRE the section (fail if the profile is not up)
./verify.sh --no-shielded-night    # skip it even when the profile is up
```

### What bring-up actually does, in order

1. **`shielded-night-fund`** (toolkit one-shot) waits for finality to move off genesis, then
   gives the deployer and the verify driver 10,000,000 NIGHT each and registers their DUST
   addresses, waiting until a *spendable* DUST UTXO exists. It **skips** a wallet that already
   holds NIGHT and DUST, so the second and later `./up.sh` runs cost seconds rather than
   minutes. On the ledger-9 line this step is not optional: a wallet holding NIGHT with no
   registered DUST cannot pay a fee at all, and the failure would surface inside transaction
   balancing with an error naming none of this.
2. **`shielded-night-deploy`** (one-shot, `restart: "no"`) waits for node block #1, the proof
   server and the indexer, then deploys the contract and publishes `contract.json` to its
   named volume — temp file plus `mv`, so a reader can never see a half-written record. If a
   record is already there it JOINs and exits 0 without deploying.
3. **`shielded-night`** (nginx) starts only on the one-shot's
   `service_completed_successfully`, blocks until it can read the address, writes `/config.js`
   and execs nginx.
4. `up.sh` then waits for the container healthcheck **and reads the address back off the
   volume**, naming it in the summary line. `service_completed_successfully` alone is not
   enough: it is equally satisfied by a one-shot that took the JOIN path against a volume left
   over from a previous chain.

The first bring-up is the slow one — funding plus a real contract deploy proved on a cold
chain — which is why `SHIELDED_NIGHT_WAIT_TIMEOUT` defaults to 900 s rather than the core
services' 120–420 s.

### Redeploy semantics

The contract is deployed **once per stack**, and that is a correctness property rather than an
optimisation: the sNight token colour is derived from the contract address, so a silent
redeploy turns every sNight coin already minted into a different, unspendable token.

* `./up.sh` again, `--force-recreate`, a restarted deploy container → **same address**
  (the one-shot logs `JOIN: … already exists — NOT deploying a second contract`).
* `./down.sh` (no `-v`) → the volume survives with the chain; the same contract comes back.
* `./down.sh -v` → the volume goes with the chain, and the next bring-up deploys a **new**
  contract at a new address. That is the only supported way to get one.

After a redeploy the page must be restarted to pick the new address up, because the entrypoint
reads the volume once at container start. `./up.sh` orders this correctly on its own; if you
drop the volume by hand, `docker compose … restart shielded-night`.

### Locking

`SHIELDED_NIGHT_LOCK=true` makes the one-shot run upstream's `deploy-and-lock.ts`, which
dissolves the contract's maintenance committee. That is a **one-way door** meant for hosted
releases: no verifier key and no rule can ever be changed again. A throwaway devnet contract
that dies with `./down.sh -v` gains nothing from it, so it is off by default — and `verify.sh`
asserts the authority state in **both** directions, failing if the contract is locked when
nobody asked for it.

Note that upstream's `verify-deployment.ts`, by default, exits non-zero on an unlocked contract
*even when all 11 verifier keys match*, because its own contract is "the code matches AND the
contract is immutable" — wrong for a throwaway devnet deploy, which is deliberately never
locked. Since shielded-night `ledger-v9` @ `36caf599…` (project 00007 phase F2, upstream PR #12)
the script takes `--allow-unlocked`: the lock state is still measured and printed, but only the
verifier-key/circuit-set check decides the exit code, so `images/shielded-night/entrypoint-verify.sh`
now trusts that exit status directly instead of parsing stdout (project 00007 Q8/F2).

### What the verify section asserts

`scripts/verify-shielded-night.sh`, in order: the page serves HTML; `/config.js` is the
**generated** one (upstream ships a placeholder, so a 200 proves nothing) and carries *exactly*
the address on the volume; `index.html` loads it as a classic script; the deploy record names
`networkId=undeployed` and the fields the docs promise; all 33 ZK artifacts (11 circuits ×
prover/verifier/bzkir) answer with non-empty non-HTML bytes; `compiler/contract-manifest.json`
is served, names compactc 0.34.0 and covers all 11 circuits; a circuit that does not exist
answers **404**, never the SPA shell; the on-chain verifier keys equal the served ones 11/11;
and a funded driver wallet distinct from the deployer completes **both** round trips — atomic
and two-step — with exact balance assertions, by running the *upstream* integration suite
against this stack (`MN_EXTERNAL_STACK=1`).

**Budget minutes for the round trips.** The same two tests take ~280 s against the 1.x triple
and were measured at 487–537 s in the `ledger-v9` branch's own CI: proving on the 2.x line runs
about 1.25–1.6× slower.
