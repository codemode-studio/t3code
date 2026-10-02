/**
 * Schema owned by this fork, tracked in its own `t3_fork_migrations` ledger so upstream
 * migration ids stay upstream's.
 *
 * Earlier fork builds recorded their migrations in `effect_sql_migrations` under ids upstream
 * later used. The upstream migrator only runs ids above the highest recorded one, so a database
 * holding `55_Notes` would silently skip `55_OrchestrationV2`. `reconcileForkMigrationLedger`
 * moves exactly those known fork rows into the fork ledger before the upstream migrator runs.
 *
 * @module forkMigrations
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Notes from "./ForkMigrations/001_Notes.ts";

const forkMigrationEntries = [[1, "Notes", Notes]] as const;

/**
 * Rows earlier fork builds wrote into the upstream ledger, with the fork migration that now owns
 * them. `ProjectionThreadsParentThreadId` has none: its column stays on the legacy V1 table as
 * preserved data that nothing reads, so its row is only removed.
 */
const LEGACY_FORK_ROWS: ReadonlyArray<{
  readonly migrationId: number;
  readonly name: string;
  readonly forkId: number | null;
}> = [
  { migrationId: 54, name: "Notes", forkId: 1 },
  { migrationId: 55, name: "Notes", forkId: 1 },
  { migrationId: 56, name: "ProjectionThreadsParentThreadId", forkId: null },
];

const ensureForkLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS t3_fork_migrations (
      migration_id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
});

/** Moves known fork rows out of the upstream ledger; returns the upstream rows it removed. */
export const reconcileForkMigrationLedger = Effect.fn("reconcileForkMigrationLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 54
      `;
      const legacy = LEGACY_FORK_ROWS.filter((row) =>
        history.some((entry) => entry.migration_id === row.migrationId && entry.name === row.name),
      );
      if (legacy.length === 0) return [];
      yield* ensureForkLedger;
      for (const row of legacy) {
        yield* sql`
          DELETE FROM effect_sql_migrations
          WHERE migration_id = ${row.migrationId} AND name = ${row.name}
        `;
        const owner = forkMigrationEntries.find(([id]) => id === row.forkId);
        if (owner !== undefined) {
          yield* sql`
            INSERT OR IGNORE INTO t3_fork_migrations (migration_id, name)
            VALUES (${owner[0]}, ${owner[1]})
          `;
        }
      }
      return legacy.map((row) => [row.migrationId, row.name] as const);
    }),
  );
});

/** Runs fork migrations not yet in the fork ledger, after upstream's. */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* ensureForkLedger;
      const recorded = new Set(
        (yield* sql<{ readonly migration_id: number }>`
          SELECT migration_id FROM t3_fork_migrations
        `).map((row) => row.migration_id),
      );
      const executed: Array<readonly [number, string]> = [];
      for (const [id, name, migration] of forkMigrationEntries) {
        if (recorded.has(id)) continue;
        yield* migration;
        yield* sql`INSERT INTO t3_fork_migrations (migration_id, name) VALUES (${id}, ${name})`;
        executed.push([id, name]);
      }
      return executed;
    }),
  );
});
