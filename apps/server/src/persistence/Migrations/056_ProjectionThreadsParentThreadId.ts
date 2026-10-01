import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds the delegating thread to each thread. Delegations made before this
 * column existed are recovered from the parent's `delegation:<child>:started`
 * activity, which names both threads.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_thread_id TEXT
    `;
  }
  yield* sql`
    UPDATE projection_threads
    SET parent_thread_id = (
      SELECT activity.thread_id
      FROM projection_thread_activities AS activity
      WHERE activity.activity_id = 'delegation:' || projection_threads.thread_id || ':started'
    )
    WHERE parent_thread_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_thread_activities AS activity
        WHERE activity.activity_id = 'delegation:' || projection_threads.thread_id || ':started'
      )
  `;
});
