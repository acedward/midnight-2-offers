/**
 * Applies the `evm_rpc` migration lineage, as a one-shot init step.
 *
 *   npx tsx tools/migrate.ts
 *
 * WHY THIS EXISTS (plan T3.4 — "confirm serve-all does this; else add an init step")
 * ---------------------------------------------------------------------------------
 * It does not. `evm-rpc/serve-all.ts` never calls `runMigrations`/`bootstrapEvmRpcSchema`; it goes
 * straight to `backfillWatched(...)`, `registerGetLogs(...)` and `startIngest(...)`, all of which
 * read or write `<schema>.logs`. The only upstream caller of `bootstrapEvmRpcSchema` is
 * `wallet-monitor/monitor.ts`. So on a virgin Postgres the two services race: whichever starts
 * first wins, and if it is `evm-rpc` it dies on a missing relation.
 *
 * Relying on `depends_on: wallet-monitor` instead would be wrong twice over — it would make the
 * RPC surface's availability depend on the monitor staying up, and `service_started` says nothing
 * about the migration having finished. An explicit one-shot with
 * `service_completed_successfully` is the only ordering that actually means "the schema exists".
 *
 * The lineage is `000_schema` + `001_evm_rpc_core` (address_map, balances, utxos, tx_index) +
 * `010_logs` (logs, log_cursors), tracked individually in `<schema>._migrations`, so re-running
 * this is a no-op and it is safe on every bring-up.
 */
import { createClient } from "../src/postgres/client.js";
import { bootstrapEvmRpcSchema } from "../wallet-monitor/bootstrap.js";

// PG_URL is what evm-rpc reads; ARCHIVE_PG is what wallet-monitor reads (they are the same
// database — see compose/evm.yml). Accept either so this tool cannot be pointed at a
// third, unrelated database by accident.
const connectionString = process.env.PG_URL ?? process.env.ARCHIVE_PG;
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("migrate: PG_URL (or ARCHIVE_PG) is required");
}
const schema = process.env.EVM_RPC_SCHEMA ?? "evm_rpc";

const log = (event: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: "evm-migrate", event, ...extra }));
};

const sql = createClient({ connectionString, schema });
try {
  log("start", { schema });
  await bootstrapEvmRpcSchema(sql, schema);
  const applied = await sql<{ name: string }[]>`
    SELECT name FROM ${sql(schema)}._migrations ORDER BY name
  `;
  log("done", { schema, migrations: applied.map((row) => row.name) });
} finally {
  await sql.end({ timeout: 5 });
}
