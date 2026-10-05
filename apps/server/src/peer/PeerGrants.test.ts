import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { PeerGrantId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PeerGrants from "./PeerGrants.ts";

const projectId = ProjectId.make("project:peer-grants");
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const testLayer = PeerGrants.layer.pipe(
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(id === projectId ? Option.some({ id } as never) : Option.none()),
    }),
  ),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const grantInput = {
  label: "Mainbook",
  projectIds: [projectId] as const,
  maxRuntimeMode: "auto",
  maxInteractionMode: "default",
  runSetupScripts: false,
} as const;

/** A projection row is all the setup policy reads, so tests insert one directly. */
const insertThread = (threadId: string, peerGrantId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = yield* encodeJson(
      peerGrantId === null ? {} : { peerOrigin: { grantId: peerGrantId, label: "Mainbook" } },
    );
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      )
      VALUES (
        ${threadId}, ${projectId}, 'Thread', 'codex', 'auto', 'default',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ${payload}
      )
    `;
  });

it.effect("authenticates only the exact, unrevoked secret", () =>
  Effect.gen(function* () {
    const grants = yield* PeerGrants.PeerGrants;
    const { grant, secret } = yield* grants.create(grantInput);
    expect(Option.getOrNull(yield* grants.authenticate(secret))?.id).toBe(grant.id);
    expect(Option.isNone(yield* grants.authenticate(`${secret}x`))).toBe(true);
    expect(Option.isNone(yield* grants.authenticate("not-a-grant-secret"))).toBe(true);
    // The first use is recorded so admins can see stale grants.
    expect((yield* grants.list)[0]?.lastUsedAt).not.toBeNull();

    expect(yield* grants.revoke(grant.id)).toBe(true);
    expect(Option.isNone(yield* grants.authenticate(secret))).toBe(true);
    expect(yield* grants.list).toEqual([]);
    expect(yield* grants.revoke(grant.id)).toBe(false);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a grant for a project this environment does not have", () =>
  Effect.gen(function* () {
    const grants = yield* PeerGrants.PeerGrants;
    const error = yield* grants
      .create({ ...grantInput, projectIds: [ProjectId.make("project:missing")] })
      .pipe(Effect.flip);
    expect(error._tag).toBe("PeerGrantProjectNotFoundError");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("allows setup scripts only where the peer grant allows them", () =>
  Effect.gen(function* () {
    const grants = yield* PeerGrants.PeerGrants;
    const blocked = yield* grants.create(grantInput);
    const allowed = yield* grants.create({ ...grantInput, runSetupScripts: true });
    yield* insertThread("thread:trusted", null);
    yield* insertThread("thread:blocked", blocked.grant.id);
    yield* insertThread("thread:allowed", allowed.grant.id);
    yield* insertThread("thread:unknown-grant", PeerGrantId.make("grant:unknown"));

    expect(yield* grants.allowsSetupScript("thread:trusted")).toBe(true);
    expect(yield* grants.allowsSetupScript("thread:missing")).toBe(true);
    expect(yield* grants.allowsSetupScript("thread:blocked")).toBe(false);
    expect(yield* grants.allowsSetupScript("thread:allowed")).toBe(true);
    expect(yield* grants.allowsSetupScript("thread:unknown-grant")).toBe(false);

    // Revoking the grant takes the permission away from work it already started.
    yield* grants.revoke(allowed.grant.id);
    expect(yield* grants.allowsSetupScript("thread:allowed")).toBe(false);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps the first launch claim for an id", () =>
  Effect.gen(function* () {
    const grants = yield* PeerGrants.PeerGrants;
    const { grant } = yield* grants.create(grantInput);
    const threadId = ThreadId.make("thread:peer:claimed");
    expect(yield* grants.claimLaunch(grant.id, threadId, "first")).toBe("first");
    expect(yield* grants.claimLaunch(grant.id, threadId, "second")).toBe("first");
    expect(yield* grants.launchedBy(grant.id, threadId)).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);
