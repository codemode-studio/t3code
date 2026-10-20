import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const upstreamLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const forkLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM t3_fork_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const tableExists = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`;
    return rows.length === 1;
  });

// The table and a row as the removed Notes feature left them.
const createLegacyNotes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      project_id TEXT,
      source_thread_id TEXT,
      source_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO notes (id, title, body, tags_json, project_id, source_thread_id, source_message_id, created_at, updated_at)
    VALUES ('old-note', 'Old', 'Body', '[]', NULL, NULL, NULL, '2026-09-24', '2026-09-24')
  `;
});

const expectUpgradedToUpstream = (expectedForkLedger: ReadonlyArray<readonly [number, string]>) =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* upstreamLedger, migrationManifest);
    assert.deepStrictEqual(yield* forkLedger, expectedForkLedger);
    assert.isTrue(yield* tableExists("orchestration_v2_events"));
    assert.isFalse(yield* tableExists("notes"));
    assert.deepStrictEqual(yield* runMigrations(), []);
  });

describe("fork migration ledger", () => {
  it.effect("runs upstream 55 and 56 on a database that recorded the fork's 55 and 56", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* createLegacyNotes;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'Notes')`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'ProjectionThreadsParentThreadId')
      `;

      assert.deepStrictEqual(yield* runMigrations(), [
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
      ]);
      yield* expectUpgradedToUpstream([[2, "DropNotes"]]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("runs the skipped upstream 54 on a database that recorded Notes as 54", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* createLegacyNotes;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'Notes')`;

      assert.deepStrictEqual(yield* runMigrations(), [
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
      ]);
      yield* expectUpgradedToUpstream([[2, "DropNotes"]]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops notes on a database whose fork ledger already ran Notes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* createLegacyNotes;
      yield* sql`
        CREATE TABLE t3_fork_migrations (
          migration_id INTEGER PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `;
      yield* sql`INSERT INTO t3_fork_migrations (migration_id, name) VALUES (1, 'Notes')`;

      assert.deepStrictEqual(yield* runMigrations(), [
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
      ]);
      yield* expectUpgradedToUpstream([
        [1, "Notes"],
        [2, "DropNotes"],
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("never creates notes on a fresh database", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* expectUpgradedToUpstream([[2, "DropNotes"]]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves rows alone unless both the id and the name are a known fork row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      // A fork migration name under another id, and another name under a fork id.
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'NotesV2')`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (57, 'Notes')`;
      const before = yield* upstreamLedger;

      // Reconcile fork rows without entering V2, which rejects these unknown collisions.
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* upstreamLedger, before);
      assert.isFalse(yield* tableExists("orchestration_v2_events"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
