import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Notes was removed. Fork builds created this table through fork migration 1 or, earlier, under
// upstream ids 54 and 55; fresh databases never have it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS notes`;
});
