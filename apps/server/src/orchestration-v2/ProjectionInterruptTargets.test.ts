import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const targets = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const parentId = ThreadId.make("interrupt:parent");
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
  const thread = (id: ThreadId, taskId: NodeId | null) => ({
    id,
    projectId: ProjectId.make("interrupt:project"),
    title: "Interrupt targets",
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    createdBy: "user" as const,
    creationSource: "web" as const,
    lineage: {
      parentThreadId: taskId === null ? null : parentId,
      rootThreadId: parentId,
      relationshipToParent: taskId === null ? null : ("subagent" as const),
    },
    forkedFrom: taskId === null ? null : { type: "node" as const, nodeId: taskId },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    settledOverride: null,
    lastVisitedAt: null,
  });
  let eventOrdinal = 0;
  const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "occurredAt">) =>
    store.apply({
      ...event,
      id: EventId.make(`interrupt:event:${eventOrdinal++}`),
      occurredAt: now,
    } as OrchestrationV2DomainEvent);
  yield* apply({ type: "thread.created", threadId: parentId, payload: thread(parentId, null) });
  for (const suffix of [
    ...Array.from({ length: 100 }, (_, index) => `idle:${index}`),
    "active",
    "queued",
    "node-owned-background",
    "subagent-owned-background",
    "archived",
    "deleted",
    "native",
    "wrong-lineage",
  ]) {
    const childId = ThreadId.make(`interrupt:${suffix}`);
    const taskId = NodeId.make(`interrupt:task:${suffix}`);
    const runId = RunId.make(`interrupt:run:${suffix}`);
    const child = {
      ...thread(childId, taskId),
      archivedAt: suffix === "archived" ? now : null,
      deletedAt: suffix === "deleted" ? now : null,
    };
    if (suffix === "wrong-lineage")
      child.lineage.parentThreadId = ThreadId.make("interrupt:other-parent");
    yield* apply({ type: "thread.created", threadId: childId, payload: child });
    yield* apply({
      type: "subagent.updated",
      threadId: parentId,
      payload: {
        id: taskId,
        threadId: parentId,
        runId: null,
        parentNodeId: NodeId.make("interrupt:root"),
        origin: suffix === "native" ? "provider_native" : "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: modelSelection.instanceId,
        providerThreadId: null,
        childThreadId: childId,
        nativeTaskRef: null,
        prompt: "Original task",
        title: null,
        model: null,
        status: "completed",
        result: "Old result",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      },
    });
    yield* apply({
      type: "run.updated",
      threadId: childId,
      runId,
      payload: {
        id: runId,
        threadId: childId,
        ordinal: 1,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`interrupt:user:${suffix}`),
        rootNodeId: null,
        activeAttemptId: null,
        status:
          suffix.startsWith("idle:") || suffix.endsWith("-owned-background")
            ? "completed"
            : suffix === "queued"
              ? "queued"
              : "running",
        requestedAt: now,
        startedAt: now,
        completedAt:
          suffix.startsWith("idle:") || suffix.endsWith("-owned-background") ? now : null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    if (suffix.endsWith("-owned-background")) {
      const ownerNodeId = NodeId.make(`interrupt:background-owner:${suffix}`);
      const providerThreadId = ProviderThreadId.make(`interrupt:background-provider:${suffix}`);
      yield* apply({
        type: "node.updated",
        threadId: childId,
        runId,
        payload: {
          id: ownerNodeId,
          threadId: childId,
          runId,
          parentNodeId: null,
          rootNodeId: ownerNodeId,
          kind: "root_turn",
          status: "completed",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* apply({
        type: "provider-thread.updated",
        threadId: childId,
        payload: {
          id: providerThreadId,
          appThreadId: null,
          ownerNodeId: suffix === "node-owned-background" ? ownerNodeId : null,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: modelSelection.instanceId,
          providerSessionId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          pendingBackgroundTasks: [{ taskId: "background-command", kind: "command" }],
          createdAt: now,
          updatedAt: now,
        },
      });
      if (suffix === "subagent-owned-background") {
        const parent = yield* store.getThreadRecords(parentId, ["subagents"]);
        const task = parent.subagents.find((task) => task.childThreadId === childId)!;
        yield* apply({
          type: "subagent.updated",
          threadId: childId,
          payload: {
            ...task,
            id: NodeId.make("interrupt:native-background-task"),
            threadId: childId,
            parentNodeId: ownerNodeId,
            origin: "provider_native",
            providerThreadId,
            childThreadId: null,
            status: "running",
            result: null,
            completedAt: null,
          },
        });
      }
    }
  }
  const normal = yield* store.getThreadSnapshotWindow(parentId, { rowLimit: 10 });
  assert.isUndefined(normal.projection.childInterruptTargets);
  const snapshot = yield* store.getThreadSnapshotWindow(parentId, {
    rowLimit: 10,
    includeInterruptTargets: true,
  });
  assert.deepEqual(
    snapshot.projection.childInterruptTargets?.toSorted((left, right) =>
      left.threadId.localeCompare(right.threadId),
    ),
    [
      {
        threadId: ThreadId.make("interrupt:active"),
        runId: RunId.make("interrupt:run:active"),
        action: "interrupt",
      },
      {
        threadId: ThreadId.make("interrupt:node-owned-background"),
        runId: RunId.make("interrupt:run:node-owned-background"),
        action: "interrupt",
      },
      {
        threadId: ThreadId.make("interrupt:queued"),
        runId: RunId.make("interrupt:run:queued"),
        action: "cancel",
      },
      {
        threadId: ThreadId.make("interrupt:subagent-owned-background"),
        runId: RunId.make("interrupt:run:subagent-owned-background"),
        action: "interrupt",
      },
    ],
  );
});

it.effect("SQLite returns only current owned child interrupt targets", () =>
  targets.pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistenceMemory)))),
);
it.effect("memory returns only current owned child interrupt targets", () =>
  targets.pipe(Effect.provide(ProjectionStore.layerMemory)),
);
