import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Notes from "./ForkMigrations/001_Notes.ts";
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

const insertNote = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO notes (id, title, body, tags_json, project_id, source_thread_id, source_message_id, created_at, updated_at)
    VALUES ('kept-note', 'Kept', 'Body', '[]', NULL, NULL, NULL, '2026-09-24', '2026-09-24')
  `;
});

const expectUpgradedToUpstream = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.deepStrictEqual(yield* upstreamLedger, migrationManifest);
  assert.deepStrictEqual(yield* forkLedger, [[1, "Notes"]]);
  assert.isTrue(yield* tableExists("orchestration_v2_events"));
  assert.deepStrictEqual(
    (yield* sql<{ readonly id: string }>`SELECT id FROM notes`).map((row) => row.id),
    ["kept-note"],
  );
  assert.deepStrictEqual(yield* runMigrations(), []);
});

describe("fork migration ledger", () => {
  it.effect("runs upstream 55 and 56 on a database that recorded the fork's 55 and 56", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* Notes;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'Notes')`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'ProjectionThreadsParentThreadId')
      `;
      yield* insertNote;

      assert.deepStrictEqual(yield* runMigrations(), [
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
      ]);
      yield* expectUpgradedToUpstream;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("runs the skipped upstream 54 on a database that recorded Notes as 54", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* Notes;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'Notes')`;
      yield* insertNote;

      assert.deepStrictEqual(yield* runMigrations(), [
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
      ]);
      yield* expectUpgradedToUpstream;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("creates notes through the fork ledger on a fresh database", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* insertNote;
      yield* expectUpgradedToUpstream;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves an upstream database's history alone and adds notes", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 56 });
      assert.isFalse(yield* tableExists("notes"));
      assert.deepStrictEqual(yield* runMigrations(), []);
      yield* insertNote;
      yield* expectUpgradedToUpstream;
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

      yield* runMigrations();
      assert.deepStrictEqual(yield* upstreamLedger, before);
      assert.isFalse(yield* tableExists("orchestration_v2_events"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
