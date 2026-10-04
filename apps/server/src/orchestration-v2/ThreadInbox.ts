import type { OrchestrationV2ThreadShell, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const DEFAULT_INBOX_LIMIT = 50;
const inboxReasonOrder = ["pending_request", "error", "unread"] as const;

/** Mirrors the client's early wake: a pending request, or a fresh completion or failure after the snooze. */
export function raisedHandWhileSnoozed(shell: OrchestrationV2ThreadShell) {
  if (shell.pendingRuntimeRequest !== null) return true;
  const completedAt = shell.latestRunCompletedAt ?? null;
  const snoozedAt = shell.snoozedAt ?? null;
  if (snoozedAt === null) return shell.status === "failed";
  return (
    (shell.status === "completed" || shell.status === "failed") &&
    completedAt !== null &&
    DateTime.isGreaterThan(completedAt, snoozedAt)
  );
}

/** Why a thread needs attention, if it does. unread mirrors the client's hasUnseenCompletion. */
function inboxReason(shell: OrchestrationV2ThreadShell, now: DateTime.Utc) {
  if (shell.pendingRuntimeRequest !== null) return "pending_request" as const;
  if (shell.settledOverride === "settled") return null;
  if (
    shell.snoozedUntil != null &&
    DateTime.isGreaterThan(shell.snoozedUntil, now) &&
    !raisedHandWhileSnoozed(shell)
  )
    return null;
  if (shell.status === "failed") return "error" as const;
  const completedAt = shell.latestRunCompletedAt ?? null;
  const visitedAt = shell.lastVisitedAt ?? null;
  return completedAt !== null &&
    visitedAt !== null &&
    DateTime.isGreaterThan(completedAt, visitedAt)
    ? ("unread" as const)
    : null;
}

/**
 * Active threads that need attention: pending requests first, then failed runs, then unread
 * completed work, newest first. Settled and snoozed threads only appear for pending requests.
 */
export class ThreadInbox extends Context.Service<
  ThreadInbox,
  {
    readonly list: (input: {
      /** Limits the inbox to one project; omitted means every project. */
      readonly projectId?: ProjectId | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<
      ReadonlyArray<{
        readonly shell: OrchestrationV2ThreadShell;
        readonly reason: (typeof inboxReasonOrder)[number];
      }>,
      Orchestrator.OrchestratorV2Error
    >;
  }
>()("t3/orchestration-v2/ThreadInbox") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;

  const list: ThreadInbox["Service"]["list"] = Effect.fn("ThreadInbox.list")(function* (input) {
    const snapshot = yield* threads.getShellSnapshot();
    const now = yield* DateTime.now;
    return snapshot.threads
      .flatMap((shell) => {
        if (shell.archivedAt !== null || shell.deletedAt !== null) return [];
        if (input.projectId !== undefined && shell.projectId !== input.projectId) return [];
        const reason = inboxReason(shell, now);
        return reason === null ? [] : [{ shell, reason }];
      })
      .toSorted(
        (left, right) =>
          inboxReasonOrder.indexOf(left.reason) - inboxReasonOrder.indexOf(right.reason) ||
          DateTime.toEpochMillis(right.shell.updatedAt) -
            DateTime.toEpochMillis(left.shell.updatedAt),
      )
      .slice(0, input.limit ?? DEFAULT_INBOX_LIMIT);
  });

  return ThreadInbox.of({ list });
});

export const layer = Layer.effect(ThreadInbox, make);
