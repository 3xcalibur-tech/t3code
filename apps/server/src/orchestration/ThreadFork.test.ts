import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderValidationError } from "../provider/Errors.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { forkThread } from "./ThreadFork.ts";

const SOURCE_ID = ThreadId.make("thread-source");
const TARGET_ID = ThreadId.make("thread-target");

const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  streaming = false,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: null,
  streaming,
  createdAt: `2026-09-30T10:00:0${id.length % 10}.000Z`,
  updatedAt: "2026-09-30T10:00:00.000Z",
});

const makeSource = (messages: ReadonlyArray<OrchestrationMessage>): OrchestrationThread => ({
  id: SOURCE_ID,
  projectId: ProjectId.make("project-1"),
  title: "Fix the parser",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "auto-accept-edits",
  interactionMode: "plan",
  pullRequests: [],
  branch: "feature/parser",
  worktreePath: "/tmp/worktrees/parser",
  latestTurn: null,
  createdAt: "2026-09-30T09:00:00.000Z",
  updatedAt: "2026-09-30T10:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages,
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

const runFork = (input: {
  readonly source: OrchestrationThread;
  readonly log: Array<string>;
  readonly commands: Array<OrchestrationCommand>;
  readonly forkConversation?: ProviderService.ProviderService["Service"]["forkConversation"];
}) =>
  forkThread({ threadId: SOURCE_ID, targetThreadId: TARGET_ID }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getThreadDetailById: (threadId) =>
            Effect.succeed(threadId === SOURCE_ID ? Option.some(input.source) : Option.none()),
          getThreadShellById: () => Effect.succeedNone,
        }),
        Layer.mock(ProviderService.ProviderService)({
          forkConversation:
            input.forkConversation ??
            ((forkInput) => Effect.sync(() => void input.log.push(`fork:${forkInput.threadId}`))),
        }),
        Layer.succeed(
          OrchestrationEngine.OrchestrationEngineService,
          OrchestrationEngine.OrchestrationEngineService.of({
            dispatch: (command) =>
              Effect.sync(() => {
                input.log.push(command.type);
                return { sequence: input.commands.push(command) };
              }),
            readEvents: () => Stream.empty,
            readThreadEvents: () => Stream.empty,
            getThreadReplayStats: () => Effect.die("unused"),
            streamDomainEvents: Stream.empty,
            subscribeDomainEvents: Effect.succeed(Stream.empty),
            latestSequence: Effect.succeed(0),
          }),
        ),
      ),
    ),
  );

it.layer(NodeServices.layer)("forkThread", (it) => {
  it.effect("binds the provider copy before creating the thread and copies its text", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const commands: Array<OrchestrationCommand> = [];
      const source = makeSource([
        message("m1", "user", "Fix the parser"),
        message("m2", "system", "Session started"),
        message("m3", "assistant", "Fixed it"),
        message("m4", "assistant", "  "),
        message("m5", "user", "Add tests"),
      ]);

      const result = yield* runFork({ source, log, commands });

      expect(result).toEqual({ threadId: TARGET_ID });
      expect(log).toEqual([
        `fork:${SOURCE_ID}`,
        "thread.create",
        "thread.history.import",
        "thread.unsettle",
      ]);
      expect(commands[0]).toMatchObject({
        threadId: TARGET_ID,
        projectId: source.projectId,
        title: "Fix the parser fork",
        modelSelection: source.modelSelection,
        runtimeMode: "auto-accept-edits",
        interactionMode: "plan",
        branch: "feature/parser",
        worktreePath: "/tmp/worktrees/parser",
      });
      const imported = commands[1];
      expect(imported?.type).toBe("thread.history.import");
      expect(imported?.type === "thread.history.import" ? imported.messages : []).toEqual([
        {
          messageId: `import:fork:${TARGET_ID}:000000`,
          role: "user",
          text: "Fix the parser",
          createdAt: source.messages[0]!.createdAt,
        },
        {
          messageId: `import:fork:${TARGET_ID}:000001`,
          role: "assistant",
          text: "Fixed it",
          createdAt: source.messages[2]!.createdAt,
        },
        {
          messageId: `import:fork:${TARGET_ID}:000002`,
          role: "user",
          text: "Add tests",
          createdAt: source.messages[4]!.createdAt,
        },
      ]);
    }),
  );

  it.effect("creates nothing for a busy, empty, or refused source", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const commands: Array<OrchestrationCommand> = [];

      const empty = yield* Effect.flip(runFork({ source: makeSource([]), log, commands }));
      // T3 can hold an accepted prompt before the provider turn starts.
      const starting = yield* Effect.flip(
        runFork({
          source: {
            ...makeSource([message("m1", "user", "Fix the parser")]),
            session: {
              threadId: SOURCE_ID,
              status: "starting",
              providerName: "codex",
              runtimeMode: "auto-accept-edits",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-09-30T10:00:00.000Z",
            },
          },
          log,
          commands,
        }),
      );
      const refused = yield* Effect.flip(
        runFork({
          source: makeSource([message("m1", "user", "Fix the parser")]),
          log,
          commands,
          forkConversation: () =>
            Effect.fail(
              new ProviderValidationError({
                operation: "ProviderService.forkConversation",
                issue: "Wait for the current turn to finish.",
              }),
            ),
        }),
      );

      expect(empty.message).toBe("This thread has no messages to fork yet.");
      expect(starting.message).toBe("Wait for the current turn to finish.");
      expect(log).toEqual([]);
      expect(refused.message).toBe("Wait for the current turn to finish.");
      expect(commands).toEqual([]);
    }),
  );
});
