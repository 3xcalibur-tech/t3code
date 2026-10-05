import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type OrchestrationV2PeerOrigin,
  type PeerGrant,
  PeerGrantId,
  ProjectId,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerGrants from "../peer/PeerGrants.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const peerOrigin: OrchestrationV2PeerOrigin = {
  grantId: PeerGrantId.make("grant:mainbook"),
  label: "Mainbook",
  claimedEnvironmentId: null,
};

it.effect("runs a peer task only in peer work, and only while its grant is active", () =>
  Effect.gen(function* () {
    let grantActive = true;
    const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
    const sends: Array<ThreadId> = [];
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(PeerGrants.PeerGrants)({
        getActive: () =>
          Effect.succeed(
            grantActive
              ? Option.some({
                  projectIds: [ProjectId.make("project:peer")],
                } as unknown as PeerGrant)
              : Option.none(),
          ),
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Effect.sync(() => void launches.push(input)).pipe(Effect.as({} as never)),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        // Only the peer threads carry this grant's origin; one runs broader than its tasks.
        getThreadShell: (threadId) =>
          Effect.succeed({
            peerOrigin: threadId === "thread:trusted" ? null : peerOrigin,
            runtimeMode: threadId === "thread:peer-broad" ? "full-access" : "auto",
            interactionMode: "default",
          } as never),
        sendToThread: (input) =>
          Effect.sync(() => void sends.push(input.threadId)).pipe(Effect.as({} as never)),
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const upsert = (id: string, threadId: string | null) =>
        decodeUpsertInput({
          id,
          title: id,
          prompt: "Check again.",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: "project:peer",
          threadId,
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "auto",
          interactionMode: "default",
        }).pipe(Effect.flatMap((input) => service.upsert({ ...input, peerOrigin })));

      const trustedBound = yield* upsert("scheduled-task:trusted-bound", "thread:trusted");
      const peerBound = yield* upsert("scheduled-task:peer-bound", "thread:peer");
      const broadBound = yield* upsert("scheduled-task:broad-bound", "thread:peer-broad");
      const unbound = yield* upsert("scheduled-task:unbound", null);
      const outside = yield* decodeUpsertInput({
        id: "scheduled-task:outside",
        title: "outside",
        prompt: "Check again.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project:not-granted",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "auto",
        interactionMode: "default",
      }).pipe(Effect.flatMap((input) => service.upsert({ ...input, peerOrigin })));
      expect(unbound.task.peerOrigin).toEqual(peerOrigin);

      // Edits keep the origin; clients cannot clear it by saving the task again.
      const edited = yield* service.upsert({
        ...(yield* decodeUpsertInput({ ...unbound.task, id: unbound.task.id })),
        title: "Edited",
      });
      expect(edited.task.peerOrigin).toEqual(peerOrigin);

      expect((yield* service.runNow({ id: trustedBound.task.id })).task.lastRunStatus).toBe(
        "failed",
      );
      expect((yield* service.runNow({ id: peerBound.task.id })).task.lastRunStatus).toBe(
        "succeeded",
      );
      expect((yield* service.runNow({ id: broadBound.task.id })).task.lastRunStatus).toBe("failed");
      expect((yield* service.runNow({ id: unbound.task.id })).task.lastRunStatus).toBe("succeeded");
      expect((yield* service.runNow({ id: outside.task.id })).task.lastRunStatus).toBe("failed");
      expect(sends).toEqual([ThreadId.make("thread:peer")]);
      expect(launches[0]?.peerOrigin).toEqual(peerOrigin);

      grantActive = false;
      expect((yield* service.runNow({ id: unbound.task.id })).task.lastRunStatus).toBe("failed");
      expect(launches).toHaveLength(1);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
