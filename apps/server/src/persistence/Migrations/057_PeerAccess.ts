import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Grants an admin created so another environment can start work here. Only a
  // hash of the secret is stored. Revoked rows stay so their ids keep resolving.
  yield* sql`
    CREATE TABLE IF NOT EXISTS peer_grants (
      grant_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      secret_hash TEXT NOT NULL UNIQUE,
      project_ids_json TEXT NOT NULL,
      max_runtime_mode TEXT NOT NULL,
      max_interaction_mode TEXT NOT NULL,
      run_setup_scripts INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    )
  `;

  // Threads a grant launched directly. Read, wait, and interrupt accept only
  // these. The fingerprint is of the checked request, so a retry that changes
  // the request cannot replay it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS peer_launches (
      grant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (grant_id, thread_id)
    ) WITHOUT ROWID
  `;

  // Immutable provenance for tasks a peer-origin agent scheduled.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN peer_origin_json TEXT`;
});
