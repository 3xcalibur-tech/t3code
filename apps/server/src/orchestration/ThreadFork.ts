import {
  CommandId,
  MessageId,
  ProviderForkThreadError,
  type ProviderForkThreadInput,
  type ProviderForkThreadResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { threadHasQueuedTurnStart } from "./ThreadSettlementPolicy.ts";

/**
 * Forks an idle thread into a new thread on the same provider instance and
 * checkout. The provider copies its native conversation and the copy is bound
 * to the new thread before it exists, as history imports do. T3 copies only
 * message text, so inherited turns have no activities or checkpoints.
 */
export const forkThread = Effect.fn("forkThread")(
  function* (input: ProviderForkThreadInput) {
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const providers = yield* ProviderService.ProviderService;
    const crypto = yield* Crypto.Crypto;
    const fail = (detail: string) =>
      new ProviderForkThreadError({ threadId: input.threadId, detail });

    const source = Option.getOrUndefined(
      yield* snapshots.getThreadDetailById(input.threadId, { activityKinds: [] }),
    );
    if (source === undefined || source.archivedAt !== null) {
      return yield* fail("Only active threads can be forked.");
    }
    if (Option.isSome(yield* snapshots.getThreadShellById(input.targetThreadId))) {
      return yield* fail(`Thread '${input.targetThreadId}' already exists.`);
    }
    // The adapter only sees its own turn. A prompt T3 has accepted but not yet
    // delivered would be copied as text the forked agent never received.
    const sourceShell = Option.getOrUndefined(yield* snapshots.getThreadShellById(source.id));
    if (
      source.session?.status === "starting" ||
      source.session?.status === "running" ||
      source.latestTurn?.state === "running" ||
      (sourceShell !== undefined &&
        threadHasQueuedTurnStart(sourceShell, DateTime.formatIso(yield* DateTime.now)))
    ) {
      return yield* fail("Wait for the current turn to finish.");
    }
    // The `import:` namespace keeps copied history through rewinds and out of
    // queued-turn detection, the same as imported agent sessions.
    const messages = source.messages
      .flatMap((message) =>
        (message.role === "user" || message.role === "assistant") &&
        !message.streaming &&
        message.text.trim().length > 0
          ? [{ role: message.role, text: message.text, createdAt: message.createdAt }]
          : [],
      )
      .map((message, index) => ({
        ...message,
        messageId: MessageId.make(
          `import:fork:${input.targetThreadId}:${String(index).padStart(6, "0")}`,
        ),
      }));
    if (messages.length === 0) {
      return yield* fail("This thread has no messages to fork yet.");
    }

    yield* providers.forkConversation({
      threadId: source.id,
      targetThreadId: input.targetThreadId,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId: input.targetThreadId,
      projectId: source.projectId,
      title: `${source.title} fork`,
      modelSelection: source.modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: source.interactionMode,
      branch: source.branch,
      worktreePath: source.worktreePath,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
    yield* engine.dispatch({
      type: "thread.history.import",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId: input.targetThreadId,
      messages,
    });
    // History import settles the thread at its last message. A fork the user
    // just asked for belongs in the active list.
    yield* engine.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId: input.targetThreadId,
      reason: "user",
    });
    return { threadId: input.targetThreadId } satisfies ProviderForkThreadResult;
  },
  (effect, input) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause._tag === "ProviderForkThreadError"
          ? cause
          : new ProviderForkThreadError({
              threadId: input.threadId,
              // Validation issues are written for users; other errors only have a message.
              detail: cause._tag === "ProviderValidationError" ? cause.issue : cause.message,
              cause,
            }),
      ),
    ),
);
