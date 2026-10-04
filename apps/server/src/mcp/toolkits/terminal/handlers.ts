import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ThreadTerminals from "../../../terminal/ThreadTerminals.ts";
import {
  readFullAccessCaller,
  readThread,
  readWritableThread,
  unavailable,
} from "../../threadAccess.ts";
import { TerminalToolkit } from "./tools.ts";

/** Errors the caller can fix become invalid requests; the rest stay opaque. */
function toMcpFailure(error: ThreadTerminals.ThreadTerminalsError) {
  switch (error._tag) {
    case "TerminalSessionLookupError":
      return new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Terminal ${error.terminalId} was not found on this thread.`,
      });
    case "TerminalNotRunningError":
      return new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Terminal ${error.terminalId} is not running; open it first.`,
      });
    case "TerminalCwdNotFoundError":
    case "TerminalCwdNotDirectoryError":
      return new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The thread's checkout folder does not exist.",
      });
    case "ThreadTerminalProjectNotFoundError":
      return new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The project was not found.",
      });
    default:
      return unavailable();
  }
}

export const TerminalToolkitHandlersLive = TerminalToolkit.toLayer({
  t3_terminal_list: (input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      const terminals = yield* (yield* ThreadTerminals.ThreadTerminals).list(thread.id);
      return {
        threadId: thread.id,
        terminals: terminals.map((terminal) => ({
          terminalId: terminal.terminalId,
          label: terminal.label,
          status: terminal.status,
          hasRunningSubprocess: terminal.hasRunningSubprocess,
          exitCode: terminal.exitCode,
          cwd: terminal.cwd,
          updatedAt: terminal.updatedAt,
        })),
      };
    }),
  t3_terminal_read: (input) =>
    Effect.gen(function* () {
      // Scrollback can hold secrets a command printed.
      yield* readFullAccessCaller(
        "Reading terminal output requires a live full-access/default thread or a full-access client.",
      );
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      const output = yield* (yield* ThreadTerminals.ThreadTerminals)
        .read({
          threadId: thread.id,
          terminalId: input.terminalId,
          maxCharacters: input.maxCharacters,
        })
        .pipe(Effect.mapError(toMcpFailure));
      return { threadId: thread.id, ...output };
    }),
  t3_terminal_control: (input) =>
    Effect.gen(function* () {
      yield* readFullAccessCaller(
        "Terminal control requires a live full-access/default thread or a full-access client.",
      );
      const {
        projection: { thread },
      } = yield* readWritableThread(input.threadId);
      const terminals = yield* ThreadTerminals.ThreadTerminals;
      switch (input.action) {
        case "open": {
          const opened = yield* terminals
            .open({
              threadId: thread.id,
              projectId: thread.projectId,
              worktreePath: thread.worktreePath,
              terminalId: input.terminalId,
            })
            .pipe(Effect.mapError(toMcpFailure));
          return { threadId: thread.id, ...opened };
        }
        case "write": {
          if (input.terminalId === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "write requires terminalId.",
            });
          }
          const data = `${input.text ?? ""}${input.enter === true ? "\r" : ""}`;
          if (data.length === 0) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "write requires text or enter.",
            });
          }
          yield* terminals
            .write({ threadId: thread.id, terminalId: input.terminalId, data })
            .pipe(Effect.mapError(toMcpFailure));
          return {
            threadId: thread.id,
            terminalId: input.terminalId,
            status: "running" as const,
          };
        }
        case "close": {
          if (input.terminalId === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "close requires terminalId.",
            });
          }
          yield* terminals
            .close({ threadId: thread.id, terminalId: input.terminalId })
            .pipe(Effect.mapError(toMcpFailure));
          return {
            threadId: thread.id,
            terminalId: input.terminalId,
            status: "closed" as const,
          };
        }
      }
    }),
});
