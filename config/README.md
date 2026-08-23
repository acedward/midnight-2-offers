# `config/` — files mounted into containers

Anything here is bind-mounted read-only into a service, so it can be edited and the service
restarted without rebuilding an image.

## `watch.json` — umbra-evm contract watch list (profile `evm`)

Mounted at `/config/watch.json` in the `evm-rpc` service (`WATCH_CONTRACTS_FILE`). It is the list
of Midnight contracts whose events are ingested into Postgres and served as `eth_getLogs` /
`eth_subscribe("logs")` / ERC20 `eth_call` views.

**It is `[]` in this repo, and that is correct**: this demo is a read-only JSON-RPC façade over a
devnet with no deployed contracts, so there is nothing to watch. JSON has no comments, hence this
file.

Entry shape (validated with zod at startup — a malformed file fails the container immediately,
which is the intent):

```json
[
  {
    "address": "d93e33114aaf78c57144d3410772cd35371db5deec6bd9c30acc755fa1a36157",
    "profile": "erc20",
    "fromBlock": 0,
    "deploymentFile": "/config/deployment.json"
  }
]
```

| Field | Required | Notes |
|---|---|---|
| `address` | yes | The Midnight contract address as **unprefixed** hex, even length. Not an EVM address. |
| `profile` | yes | `erc20` \| `erc721` \| `misc` — chooses the event→log ABI mapping. |
| `fromBlock` | no | Lower bound for the contract's first ingest. |
| `deploymentFile` | no | Path (inside the container) to a `deployment.json`, for the genesis backfill and ERC20 `name`/`symbol`. |

Two things that bite:

- **Duplicate addresses are rejected outright.** Two subscriptions on one contract would race on
  the same `log_cursors` row and interleave their cursor writes, so the loader refuses the file
  rather than corrupting the cursor.
- **`decimals` defaults to 0, not 18.** Compact contracts emit whole `Uint<128>` units, so a mint
  of 100 is 100 tokens. A `deployment.json` that nominally declares `decimals: 18` is deliberately
  ignored.

Adding an entry does not need an image rebuild — edit the file and restart `evm-rpc`.
