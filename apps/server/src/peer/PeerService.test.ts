import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type PeerGrant,
  PeerGrantId,
  type PeerLaunchInput,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerGrants from "./PeerGrants.ts";
import * as PeerService from "./PeerService.ts";

const projectId = ProjectId.make("project:leftbook");
const commit = "a".repeat(40);
const grant: PeerGrant = {
  id: PeerGrantId.make("grant:mainbook"),
  label: "Mainbook",
  projectIds: [projectId],
  maxRuntimeMode: "auto",
  maxInteractionMode: "default",
  runSetupScripts: false,
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
  lastUsedAt: null,
};
const launchInput: PeerLaunchInput = {
  clientRequestId: "check-1",
  projectId,
  prompt: "Check the login page in Safari.",
  code: { ref: "feature/login", commit },
  target: { providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  callerRuntimeMode: "full-access",
  callerInteractionMode: "default",
  sourceEnvironmentId: EnvironmentId.make("environment:mainbook"),
};

function makeLayer(options: { readonly hasCommit?: boolean; readonly launched?: boolean } = {}) {
  const launches: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const recorded = new Map<ThreadId, string>();
  // Hides launched threads, as a concurrent request sees before the first one lands.
  const race = { hideThreads: false };
  const threadId = ThreadId.make("thread:peer-launch");
  const layer = PeerService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(PeerGrants.PeerGrants)({
          claimLaunch: (_grantId, id, fingerprint) =>
            Effect.sync(() => {
              if (!recorded.has(id)) recorded.set(id, fingerprint);
              return recorded.get(id)!;
            }),
          launchFingerprint: (_grantId, id) =>
            Effect.succeed(Option.fromUndefinedOr(recorded.get(id))),
          launchedBy: () => Effect.succeed(options.launched ?? false),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("environment:leftbook"),
            label: "Leftbook",
          } as never),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/repo" } as never)),
        }),
        ServerSettings.layerTest(),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          fetchRemoteTrackingBranch: () => Effect.void,
          hasCommit: () => Effect.succeed(options.hasCommit ?? true),
          isAncestor: () => Effect.succeed(true),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launches.push(input);
              return {
                threadId: input.threadId ?? threadId,
                resumed: false,
                projection: {
                  runs: [
                    {
                      id: RunId.make("run:peer-launch"),
                      userMessageId: input.initialMessage?.messageId,
                    },
                  ],
                } as never,
              };
            }),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          // Once launched, the thread exists with its peer origin, so a retry finds it.
          getThreadShell: (id) =>
            Effect.succeed(
              !race.hideThreads && launches.some((launch) => launch.threadId === id)
                ? ({ ...launches[0], projectId, deletedAt: null } as never)
                : null,
            ),
          getThreadRecords: () =>
            Effect.succeed({
              runs: [
                {
                  id: RunId.make("run:peer-launch"),
                  userMessageId: launches[0]?.initialMessage?.messageId,
                },
              ],
            } as never),
          waitForThread: () => Effect.succeed({ run: null, timedOut: true } as never),
        }),
        Layer.mock(OrchestratorMcp.OrchestratorMcpService)({
          peer: {
            providers: Effect.succeed([
              {
                providerInstanceId: ProviderInstanceId.make("codex"),
                driverKind: ProviderDriverKind.make("codex"),
                displayName: "Codex",
                models: [{ id: "gpt-6.1-sol", label: null }],
                canRunChildTask: true,
                canRunCrossProviderChildTask: true,
                constraints: [],
              },
            ]),
            resolveModelSelection: ({ target }) =>
              Effect.succeed({ instanceId: target!.providerInstanceId!, model: target!.model! }),
            readThread: () => Effect.die("unused"),
          },
        }),
        NodeCrypto.layer,
      ),
    ),
  );
  return { layer, launches, recorded, race, threadId };
}

it.effect("starts at the exact commit, inside the grant, marked with its peer origin", () => {
  const { layer, launches, recorded } = makeLayer();
  return Effect.gen(function* () {
    const peer = yield* PeerService.PeerService;
    const result = yield* peer.launch(grant, launchInput);
    expect(result).toMatchObject({
      environmentId: "environment:leftbook",
      runId: "run:peer-launch",
    });
    expect([...recorded.keys()]).toEqual([result.threadId]);
    expect(launches[0]).toMatchObject({
      runtimeMode: "auto",
      interactionMode: "default",
      workspaceStrategy: { type: "worktree", baseRef: commit, startFromOrigin: false },
      peerOrigin: {
        grantId: grant.id,
        label: "Mainbook",
        claimedEnvironmentId: "environment:mainbook",
      },
    });

    // A retry replays the accepted launch from what B recorded. It runs no new
    // checks, so it still succeeds after the branch is gone or the caller narrows.
    expect(
      yield* peer.launch(grant, { ...launchInput, callerRuntimeMode: "approval-required" }),
    ).toEqual(result);
    expect(launches[1]).toMatchObject({
      commandId: launches[0]?.commandId,
      threadId: launches[0]?.threadId,
      runtimeMode: "auto",
      peerOrigin: launches[0]?.peerOrigin,
    });
    // A retry cannot swap in code or work that B never checked.
    const changed = yield* peer
      .launch(grant, { ...launchInput, code: { ...launchInput.code, commit: "c".repeat(40) } })
      .pipe(Effect.flip);
    expect(changed.code).toBe("invalid_request");
    expect(launches).toHaveLength(2);
  }).pipe(Effect.provide(layer));
});

it.effect("never starts work broader than the grant or the calling agent", () => {
  const { layer, launches } = makeLayer();
  return Effect.gen(function* () {
    const peer = yield* PeerService.PeerService;
    yield* peer.launch(grant, {
      ...launchInput,
      clientRequestId: "narrow",
      callerRuntimeMode: "auto-accept-edits",
      callerInteractionMode: "plan",
    });
    expect(launches[0]).toMatchObject({
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
    });

    const escalation = yield* peer
      .launch(grant, { ...launchInput, clientRequestId: "broad", runtimeMode: "full-access" })
      .pipe(Effect.flip);
    expect(escalation.code).toBe("runtime_mode_escalation_denied");
    const outside = yield* peer
      .launch(grant, { ...launchInput, projectId: ProjectId.make("project:other") })
      .pipe(Effect.flip);
    expect(outside.code).toBe("project_not_granted");
    expect(launches).toHaveLength(1);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a commit the peer has not pushed", () => {
  const { layer, launches } = makeLayer({ hasCommit: false });
  return Effect.gen(function* () {
    const peer = yield* PeerService.PeerService;
    const error = yield* peer.launch(grant, launchInput).pipe(Effect.flip);
    expect(error.code).toBe("code_unavailable");
    expect(launches).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

it.effect("only follows threads this grant launched", () => {
  const { layer } = makeLayer({ launched: false });
  return Effect.gen(function* () {
    const peer = yield* PeerService.PeerService;
    const threadId = ThreadId.make("thread:trusted");
    for (const error of [
      yield* peer.read(grant, { threadId }).pipe(Effect.flip),
      yield* peer.wait(grant, { threadId }).pipe(Effect.flip),
      yield* peer.interrupt(grant, { threadId }).pipe(Effect.flip),
    ]) {
      expect(error.code).toBe("thread_not_granted");
    }
  }).pipe(Effect.provide(layer));
});

it.effect("lets only the first of two racing requests for one id start work", () => {
  const { layer, launches, race } = makeLayer();
  return Effect.gen(function* () {
    const peer = yield* PeerService.PeerService;
    const first = yield* peer.launch(grant, launchInput);
    // The second request read "no thread" before the first one landed.
    race.hideThreads = true;
    const changed = yield* peer
      .launch(grant, { ...launchInput, code: { ...launchInput.code, commit: "c".repeat(40) } })
      .pipe(Effect.flip);
    expect(changed.code).toBe("invalid_request");
    expect(launches).toHaveLength(1);

    // The first request still owns the id, so its retry still works.
    race.hideThreads = false;
    expect(yield* peer.launch(grant, launchInput)).toEqual(first);
  }).pipe(Effect.provide(layer));
});
