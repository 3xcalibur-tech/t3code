import {
  CommandId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  planPinnedReorder,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/shared/threadOrderKeys";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { OrchestratorV2Error } from "./Orchestrator.ts";
import { raisedHandWhileSnoozed } from "./ThreadInbox.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const ThreadOrderList = Schema.Literals(["pinned", "active"]);
export type ThreadOrderList = typeof ThreadOrderList.Type;

export class ThreadOrderingThreadNotInListError extends Schema.TaggedError<ThreadOrderingThreadNotInListError>()(
  "ThreadOrderingThreadNotInListError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
    list: ThreadOrderList,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} is not in the ${this.list} list of project ${this.projectId}.`;
  }
}

export class ThreadOrderingAnchorNotInListError extends Schema.TaggedError<ThreadOrderingAnchorNotInListError>()(
  "ThreadOrderingAnchorNotInListError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
    beforeThreadId: ThreadId,
    list: ThreadOrderList,
  },
) {
  override get message(): string {
    return `Thread ${this.beforeThreadId} is not another thread in the ${this.list} list of project ${this.projectId}.`;
  }
}

export class ThreadOrdering extends Context.Service<
  ThreadOrdering,
  {
    /**
     * Moves a thread within its project's pinned or active sidebar list, as a client drag
     * does. `beforeThreadId` is the thread to land above, or null for the end. Usually one
     * key write; keyless or corrupt neighbors rewrite the list once. `authorizeRewrite` runs
     * for every other thread whose key would change, before anything is dispatched.
     * Each write uses `${commandId}:reorder:${threadId}`. A no-op returns the snapshot sequence.
     */
    readonly moveThread: <E>(input: {
      readonly commandId: CommandId;
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly list: ThreadOrderList;
      readonly beforeThreadId: ThreadId | null;
      readonly authorizeRewrite: (shell: OrchestrationV2ThreadShell) => Effect.Effect<void, E>;
    }) => Effect.Effect<
      { readonly sequence: number },
      | ThreadOrderingThreadNotInListError
      | ThreadOrderingAnchorNotInListError
      | OrchestratorV2Error
      | E
    >;
  }
>()("t3/orchestration-v2/ThreadOrdering") {}

/** The sidebar list a thread shows in, with the client's precedence. */
function sidebarList(shell: OrchestrationV2ThreadShell, now: DateTime.Utc) {
  if (
    shell.snoozedUntil != null &&
    DateTime.isGreaterThan(shell.snoozedUntil, now) &&
    !raisedHandWhileSnoozed(shell)
  )
    return "snoozed";
  if (shell.settledOverride === "settled") return "settled";
  return shell.pinnedAt != null ? "pinned" : "active";
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;

  const moveThread: ThreadOrdering["Service"]["moveThread"] = (input) =>
    Effect.gen(function* () {
      const { list, threadId: movedId } = input;
      const snapshot = yield* threads.getShellSnapshot();
      const now = yield* DateTime.now;
      // The sidebar's view: this project's visible threads in the list, in client order.
      const rows = snapshot.threads
        .filter(
          (shell) =>
            shell.projectId === input.projectId &&
            shell.archivedAt === null &&
            shell.deletedAt === null &&
            shell.lineage.relationshipToParent !== "subagent" &&
            sidebarList(shell, now) === list,
        )
        .map((shell) => ({
          id: shell.id,
          createdAt: DateTime.formatIso(shell.createdAt),
          unsettledAt: shell.unsettledAt == null ? null : DateTime.formatIso(shell.unsettledAt),
          pinOrderKey: shell.pinOrderKey,
          activeOrderKey: shell.activeOrderKey,
        }));
      const ordered = (
        list === "pinned" ? sortPinnedThreadsByOrderKey(rows) : sortActiveThreadsByOrderKey(rows)
      ).map((row) => row.id);
      if (!ordered.includes(movedId)) {
        return yield* new ThreadOrderingThreadNotInListError({
          projectId: input.projectId,
          threadId: movedId,
          list,
        });
      }
      const others = ordered.filter((id) => id !== movedId);
      const at =
        input.beforeThreadId === null ? others.length : others.indexOf(input.beforeThreadId);
      if (input.beforeThreadId !== null && at === -1) {
        return yield* new ThreadOrderingAnchorNotInListError({
          projectId: input.projectId,
          threadId: movedId,
          beforeThreadId: input.beforeThreadId,
          list,
        });
      }
      const orderedIds = others.toSpliced(at, 0, movedId);
      if (orderedIds.every((id, index) => id === ordered[index])) {
        return { sequence: snapshot.snapshotSequence };
      }
      // Keys on rows outside the list stay reserved.
      const shells = new Map(snapshot.threads.map((shell) => [shell.id, shell]));
      const assignments = planPinnedReorder({
        orderedIds,
        keysById: new Map(
          snapshot.threads.map((shell) => [
            shell.id,
            list === "pinned" ? shell.pinOrderKey : shell.activeOrderKey,
          ]),
        ),
        movedId,
      });
      for (const { id } of assignments) {
        const shell = shells.get(ThreadId.make(id));
        if (shell !== undefined && shell.id !== movedId) yield* input.authorizeRewrite(shell);
      }
      let sequence = snapshot.snapshotSequence;
      for (const { id, orderKey } of assignments) {
        const reorder = {
          commandId: CommandId.make(`${input.commandId}:reorder:${id}`),
          threadId: ThreadId.make(id),
          orderKey,
        };
        const result = yield* threads.dispatch(
          list === "pinned"
            ? { ...reorder, type: "thread.pin.reorder" }
            : { ...reorder, type: "thread.active.reorder" },
        );
        sequence = result.sequence;
      }
      return { sequence };
    }).pipe(Effect.withSpan("ThreadOrdering.moveThread"));

  return ThreadOrdering.of({ moveThread });
});

export const layer = Layer.effect(ThreadOrdering, make);
