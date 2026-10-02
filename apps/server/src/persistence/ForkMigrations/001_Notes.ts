import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Databases from fork builds that recorded Notes in the upstream ledger already
// have this table, so every statement tolerates an existing schema.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS notes (
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
  yield* sql`CREATE INDEX IF NOT EXISTS notes_updated_at ON notes(updated_at DESC)`;
  yield* sql`CREATE INDEX IF NOT EXISTS notes_project_id ON notes(project_id)`;
});
