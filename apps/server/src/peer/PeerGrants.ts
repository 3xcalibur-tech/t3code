import * as NodeCrypto from "node:crypto";

import {
  PeerGrant,
  PeerGrantId,
  type PeerGrantCreateInput,
  type PeerGrantCreateResult,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProjectService from "../project/ProjectService.ts";

export class PeerGrantStoreError extends Schema.TaggedError<PeerGrantStoreError>()(
  "PeerGrantStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Peer grant ${this.operation} failed.`;
  }
}

export class PeerGrantProjectNotFoundError extends Schema.TaggedError<PeerGrantProjectNotFoundError>()(
  "PeerGrantProjectNotFoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId} does not exist in this environment.`;
  }
}

/**
 * Grants an admin created so another environment's agents can start work here.
 * The secret is shown once; only its SHA-256 is stored.
 */
export class PeerGrants extends Context.Service<
  PeerGrants,
  {
    readonly list: Effect.Effect<ReadonlyArray<PeerGrant>, PeerGrantStoreError>;
    readonly create: (
      input: PeerGrantCreateInput,
    ) => Effect.Effect<PeerGrantCreateResult, PeerGrantStoreError | PeerGrantProjectNotFoundError>;
    readonly revoke: (id: PeerGrantId) => Effect.Effect<boolean, PeerGrantStoreError>;
    /** Resolves the active grant for a secret and records the use. */
    readonly authenticate: (
      secret: string,
    ) => Effect.Effect<Option.Option<PeerGrant>, PeerGrantStoreError>;
    /** The grant if it exists and is not revoked. */
    readonly getActive: (
      id: PeerGrantId,
    ) => Effect.Effect<Option.Option<PeerGrant>, PeerGrantStoreError>;
    /**
     * Claims a launch id for one checked request before it starts. The first
     * claim wins and never changes; returns the fingerprint that holds the id.
     */
    readonly claimLaunch: (
      grantId: PeerGrantId,
      threadId: ThreadId,
      requestFingerprint: string,
    ) => Effect.Effect<string, PeerGrantStoreError>;
    readonly launchFingerprint: (
      grantId: PeerGrantId,
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<string>, PeerGrantStoreError>;
    /** True only for threads this grant launched directly through the peer API. */
    readonly launchedBy: (
      grantId: PeerGrantId,
      threadId: ThreadId,
    ) => Effect.Effect<boolean, PeerGrantStoreError>;
    /**
     * False when the thread came from a peer whose grant does not allow setup
     * scripts, or whose grant was revoked. Threads without peer origin are allowed.
     */
    readonly allowsSetupScript: (threadId: string) => Effect.Effect<boolean, PeerGrantStoreError>;
  }
>()("t3/peer/PeerGrants") {}

const SECRET_PREFIX = "t3pg_";
/** Skip `last_used_at` writes closer together than this, so long-polls do not write per request. */
const LAST_USED_RESOLUTION_MS = 60_000;

const GrantRow = Schema.Struct({
  grantId: PeerGrantId,
  label: Schema.String,
  projectIdsJson: Schema.String,
  maxRuntimeMode: Schema.String,
  maxInteractionMode: Schema.String,
  runSetupScripts: Schema.Number,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
});
type GrantRow = typeof GrantRow.Type;

const decodeGrant = Schema.decodeUnknownEffect(Schema.toCodecJson(PeerGrant));
const ProjectIdsJson = Schema.fromJsonString(Schema.Array(ProjectId));
const decodeProjectIds = Schema.decodeUnknownEffect(ProjectIdsJson);
const encodeProjectIds = Schema.encodeEffect(ProjectIdsJson);

function hashSecret(secret: string): string {
  return NodeCrypto.createHash("sha256").update(secret).digest("hex");
}

function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const projects = yield* ProjectService.ProjectService;

  const fail = (operation: string) => (cause: unknown) =>
    new PeerGrantStoreError({ operation, cause });
  const grantColumns = sql.literal(`
    grant_id AS "grantId",
    label AS "label",
    project_ids_json AS "projectIdsJson",
    max_runtime_mode AS "maxRuntimeMode",
    max_interaction_mode AS "maxInteractionMode",
    run_setup_scripts AS "runSetupScripts",
    created_at AS "createdAt",
    last_used_at AS "lastUsedAt"
  `);

  const toGrant = (row: GrantRow) =>
    decodeProjectIds(row.projectIdsJson).pipe(
      Effect.flatMap((projectIds) =>
        decodeGrant({
          id: row.grantId,
          label: row.label,
          projectIds,
          maxRuntimeMode: row.maxRuntimeMode,
          maxInteractionMode: row.maxInteractionMode,
          runSetupScripts: row.runSetupScripts === 1,
          createdAt: row.createdAt,
          lastUsedAt: row.lastUsedAt,
        }),
      ),
    );

  const firstGrant = (rows: ReadonlyArray<GrantRow>) =>
    rows[0] === undefined ? Effect.succeedNone : Effect.asSome(toGrant(rows[0]));

  const selectActiveById = (id: PeerGrantId) =>
    sql<GrantRow>`
      SELECT ${grantColumns} FROM peer_grants
      WHERE grant_id = ${id} AND revoked_at IS NULL
    `.pipe(Effect.flatMap(firstGrant));

  const selectActiveBySecretHash = (secretHash: string) =>
    sql<GrantRow>`
      SELECT ${grantColumns} FROM peer_grants
      WHERE secret_hash = ${secretHash} AND revoked_at IS NULL
    `.pipe(Effect.flatMap(firstGrant));

  const list: PeerGrants["Service"]["list"] = sql<GrantRow>`
    SELECT ${grantColumns} FROM peer_grants
    WHERE revoked_at IS NULL
    ORDER BY created_at DESC
  `.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, toGrant)),
    Effect.mapError(fail("list")),
  );

  const create: PeerGrants["Service"]["create"] = Effect.fn("PeerGrants.create")(function* (input) {
    for (const projectId of new Set<ProjectId>(input.projectIds)) {
      const project = yield* projects.getById(projectId).pipe(Effect.mapError(fail("create")));
      if (Option.isNone(project)) {
        return yield* new PeerGrantProjectNotFoundError({ projectId });
      }
    }
    const id = PeerGrantId.make(yield* crypto.randomUUIDv4.pipe(Effect.mapError(fail("create"))));
    const secret = `${SECRET_PREFIX}${NodeCrypto.randomBytes(32).toString("base64url")}`;
    const createdAt = iso(yield* DateTime.now);
    const projectIds = [...new Set<ProjectId>(input.projectIds)];
    const projectIdsJson = yield* encodeProjectIds(projectIds).pipe(
      Effect.mapError(fail("create")),
    );
    yield* sql`
        INSERT INTO peer_grants (
          grant_id, label, secret_hash, project_ids_json, max_runtime_mode,
          max_interaction_mode, run_setup_scripts, created_at, last_used_at, revoked_at
        )
        VALUES (
          ${id}, ${input.label}, ${hashSecret(secret)}, ${projectIdsJson},
          ${input.maxRuntimeMode}, ${input.maxInteractionMode}, ${input.runSetupScripts ? 1 : 0},
          ${createdAt}, NULL, NULL
        )
      `.pipe(Effect.mapError(fail("create")));
    const grant = yield* decodeGrant({
      id,
      label: input.label,
      projectIds,
      maxRuntimeMode: input.maxRuntimeMode,
      maxInteractionMode: input.maxInteractionMode,
      runSetupScripts: input.runSetupScripts,
      createdAt,
      lastUsedAt: null,
    }).pipe(Effect.mapError(fail("create")));
    return { grant, secret };
  });

  const revoke: PeerGrants["Service"]["revoke"] = (id) =>
    Effect.gen(function* () {
      const revokedAt = iso(yield* DateTime.now);
      const rows = yield* sql<{ grantId: string }>`
        UPDATE peer_grants SET revoked_at = ${revokedAt}
        WHERE grant_id = ${id} AND revoked_at IS NULL
        RETURNING grant_id AS "grantId"
      `;
      return rows.length > 0;
    }).pipe(Effect.mapError(fail("revoke")));

  const authenticate: PeerGrants["Service"]["authenticate"] = (secret) =>
    Effect.gen(function* () {
      if (!secret.startsWith(SECRET_PREFIX)) return Option.none();
      const grant = yield* selectActiveBySecretHash(hashSecret(secret));
      if (Option.isNone(grant)) return grant;
      const now = yield* DateTime.now;
      const staleBefore = iso(DateTime.subtract(now, { milliseconds: LAST_USED_RESOLUTION_MS }));
      yield* sql`
        UPDATE peer_grants SET last_used_at = ${iso(now)}
        WHERE grant_id = ${grant.value.id}
          AND (last_used_at IS NULL OR last_used_at < ${staleBefore})
      `;
      return grant;
    }).pipe(Effect.mapError(fail("authenticate")));

  const getActive: PeerGrants["Service"]["getActive"] = (id) =>
    selectActiveById(id).pipe(Effect.mapError(fail("read")));

  const claimLaunch: PeerGrants["Service"]["claimLaunch"] = (
    grantId,
    threadId,
    requestFingerprint,
  ) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO peer_launches (grant_id, thread_id, request_fingerprint, created_at)
        VALUES (${grantId}, ${threadId}, ${requestFingerprint}, ${iso(yield* DateTime.now)})
        ON CONFLICT (grant_id, thread_id) DO NOTHING
      `;
      const rows = yield* sql<{ fingerprint: string }>`
        SELECT request_fingerprint AS "fingerprint" FROM peer_launches
        WHERE grant_id = ${grantId} AND thread_id = ${threadId}
      `;
      return rows[0]?.fingerprint ?? requestFingerprint;
    }).pipe(Effect.mapError(fail("claim launch")));

  const launchFingerprint: PeerGrants["Service"]["launchFingerprint"] = (grantId, threadId) =>
    sql<{ fingerprint: string }>`
      SELECT request_fingerprint AS "fingerprint" FROM peer_launches
      WHERE grant_id = ${grantId} AND thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => Option.fromUndefinedOr(rows[0]?.fingerprint)),
      Effect.mapError(fail("read launch")),
    );

  const launchedBy: PeerGrants["Service"]["launchedBy"] = (grantId, threadId) =>
    sql<{ found: number }>`
      SELECT 1 AS "found" FROM peer_launches
      WHERE grant_id = ${grantId} AND thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(fail("read launch")),
    );

  const allowsSetupScript: PeerGrants["Service"]["allowsSetupScript"] = (threadId) =>
    sql<{ grantId: string | null; allowed: number | null }>`
      SELECT
        json_extract(t.payload_json, '$.peerOrigin.grantId') AS "grantId",
        g.run_setup_scripts AS "allowed"
      FROM orchestration_v2_projection_threads t
      LEFT JOIN peer_grants g
        ON g.grant_id = json_extract(t.payload_json, '$.peerOrigin.grantId')
        AND g.revoked_at IS NULL
      WHERE t.thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return row === undefined || row.grantId === null || row.allowed === 1;
      }),
      Effect.mapError(fail("read setup policy")),
    );

  return PeerGrants.of({
    list,
    create,
    revoke,
    authenticate,
    getActive,
    claimLaunch,
    launchFingerprint,
    launchedBy,
    allowsSetupScript,
  });
});

export const layer = Layer.effect(PeerGrants, make);
