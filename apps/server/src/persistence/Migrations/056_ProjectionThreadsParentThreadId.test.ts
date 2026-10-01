import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateParentThreadId from "./056_ProjectionThreadsParentThreadId.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "056_ProjectionThreadsParentThreadId",
  (it) => {
    it.effect("links existing delegated threads to the thread that started them", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 55 });
        const now = "2026-01-01T00:00:00.000Z";
        for (const threadId of ["parent", "child", "unrelated"]) {
          yield* sql`
            INSERT INTO projection_threads (
              thread_id, project_id, title, model_selection_json, runtime_mode,
              created_at, updated_at
            ) VALUES (
              ${threadId}, 'project-1', 'Thread',
              '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
            )
          `;
        }
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
          ) VALUES (
            'delegation:child:started', 'parent', NULL, 'info', 'task.started',
            'Delegated task started', '{}', ${now}
          )
        `;
        yield* runMigrations({ toMigrationInclusive: 56 });
        const parents = yield* sql<{
          readonly threadId: string;
          readonly parentThreadId: string | null;
        }>`
          SELECT thread_id AS "threadId", parent_thread_id AS "parentThreadId"
          FROM projection_threads
          ORDER BY thread_id
        `;
        assert.deepEqual(parents, [
          { threadId: "child", parentThreadId: "parent" },
          { threadId: "parent", parentThreadId: null },
          { threadId: "unrelated", parentThreadId: null },
        ]);
        // Re-running against a database that already has the column is a no-op.
        yield* migrateParentThreadId;
        const rerun = yield* sql<{ readonly parentThreadId: string | null }>`
          SELECT parent_thread_id AS "parentThreadId" FROM projection_threads WHERE thread_id = 'child'
        `;
        assert.deepEqual(rerun, [{ parentThreadId: "parent" }]);
      }),
    );
  },
);
