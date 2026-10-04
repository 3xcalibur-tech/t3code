/**
 * ThreadTerminals - a thread's terminals as the terminal panel sees them.
 *
 * Lists, reads, opens, types into, and closes one thread's shells with the
 * launch context the terminal panel uses. MCP terminal tools call it.
 *
 * @module ThreadTerminals
 */
import {
  type ProjectId,
  type TerminalAttachInput,
  type TerminalError,
  type TerminalSessionSnapshot,
  TerminalSessionLookupError,
  type TerminalSummary,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeUtil from "node:util";
import * as Project from "../project/ProjectService.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import * as TerminalManager from "./Manager.ts";

const DEFAULT_OUTPUT_CHARACTERS = 10_000;

class ThreadTerminalProjectNotFoundError extends Schema.TaggedError<ThreadTerminalProjectNotFoundError>()(
  "ThreadTerminalProjectNotFoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return "The project was not found.";
  }
}

class ThreadTerminalSnapshotMissingError extends Schema.TaggedError<ThreadTerminalSnapshotMissingError>()(
  "ThreadTerminalSnapshotMissingError",
  { threadId: Schema.String, terminalId: Schema.String },
) {
  override get message(): string {
    return `Terminal ${this.terminalId} attached without an initial snapshot.`;
  }
}

export type ThreadTerminalsError =
  | TerminalError
  | Project.ProjectOperationError
  | ThreadTerminalProjectNotFoundError
  | ThreadTerminalSnapshotMissingError;

export class ThreadTerminals extends Context.Service<
  ThreadTerminals,
  {
    /** The thread's terminals loaded since the server started. */
    readonly list: (threadId: string) => Effect.Effect<ReadonlyArray<TerminalSummary>>;
    /**
     * The last `maxCharacters` (default 10,000) of a terminal's scrollback as
     * plain text. Never starts a shell.
     */
    readonly read: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly maxCharacters?: number | undefined;
    }) => Effect.Effect<
      Pick<TerminalSessionSnapshot, "terminalId" | "label" | "status" | "exitCode" | "cwd"> & {
        readonly output: string;
        readonly truncated: boolean;
      },
      TerminalError | ThreadTerminalSnapshotMissingError
    >;
    /**
     * Start a shell in the thread's checkout, or return a running one as is.
     * Without `terminalId` it opens the thread's next free terminal.
     */
    readonly open: (input: {
      readonly threadId: string;
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
      readonly terminalId?: string | undefined;
    }) => Effect.Effect<
      {
        readonly terminalId: string;
        readonly status: TerminalSessionSnapshot["status"];
        readonly alreadyRunning: boolean;
      },
      | TerminalError
      | Project.ProjectOperationError
      | ThreadTerminalProjectNotFoundError
      | ThreadTerminalSnapshotMissingError
    >;
    /** Send input to a running terminal of the thread. */
    readonly write: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly data: string;
    }) => Effect.Effect<void, TerminalError>;
    /** Close a terminal of the thread and discard its scrollback. */
    readonly close: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<void, TerminalError>;
  }
>()("t3/terminal/ThreadTerminals") {}

/** Terminal scrollback as plain text: escape sequences out, redrawn lines keep their last write. */
function plainText(history: string) {
  return (
    NodeUtil.stripVTControlCharacters(history)
      .split(/\r*\n/)
      .map((line) => {
        const trimmed = line.replace(/\r+$/, "");
        return trimmed.slice(trimmed.lastIndexOf("\r") + 1);
      })
      .join("\n")
      // Matching control characters is the point: drop the ones left after the VT sequences.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
  );
}

const make = Effect.gen(function* () {
  const terminals = yield* TerminalManager.TerminalManager;
  const projects = yield* Project.ProjectService;
  const opens = yield* makeKeyedSerialExecutor<string>();

  /** The thread's terminals from the metadata snapshot the terminal panel starts from. */
  const list: ThreadTerminals["Service"]["list"] = Effect.fn("ThreadTerminals.list")(
    function* (threadId) {
      const captured: { all: ReadonlyArray<TerminalSummary> } = { all: [] };
      const detach = yield* terminals.subscribeMetadata((event) =>
        Effect.sync(() => {
          if (event.type === "snapshot") captured.all = event.terminals;
        }),
      );
      detach();
      return captured.all.filter((terminal) => terminal.threadId === threadId);
    },
  );

  const find = Effect.fn("ThreadTerminals.find")(function* (threadId: string, terminalId: string) {
    const terminal = (yield* list(threadId)).find(
      (candidate) => candidate.terminalId === terminalId,
    );
    if (terminal === undefined) {
      return yield* new TerminalSessionLookupError({ threadId, terminalId });
    }
    return terminal;
  });

  /**
   * Attach like a client and detach after the initial snapshot. Without a cwd an
   * attach never starts a shell, and with restartIfNotRunning it reuses a running
   * shell as is instead of restarting it for a different launch context.
   */
  const attachSnapshot = Effect.fn("ThreadTerminals.attachSnapshot")(function* (
    input: TerminalAttachInput,
  ) {
    const captured: { snapshot?: TerminalSessionSnapshot } = {};
    const detach = yield* terminals.attachStream(input, (event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") captured.snapshot ??= event.snapshot;
      }),
    );
    detach();
    // attachStream delivers the snapshot before it returns.
    if (captured.snapshot === undefined) {
      return yield* new ThreadTerminalSnapshotMissingError({
        threadId: input.threadId,
        terminalId: input.terminalId,
      });
    }
    return captured.snapshot;
  });

  const read: ThreadTerminals["Service"]["read"] = Effect.fn("ThreadTerminals.read")(
    function* (input) {
      const snapshot = yield* attachSnapshot({
        threadId: input.threadId,
        terminalId: input.terminalId,
      });
      const text = plainText(snapshot.history);
      const maxCharacters = input.maxCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
      return {
        terminalId: snapshot.terminalId,
        label: snapshot.label,
        status: snapshot.status,
        exitCode: snapshot.exitCode,
        cwd: snapshot.cwd,
        output: text.length > maxCharacters ? text.slice(-maxCharacters) : text,
        truncated: text.length > maxCharacters,
      };
    },
  );

  const open: ThreadTerminals["Service"]["open"] = Effect.fn("ThreadTerminals.open")(
    function* (input) {
      const existing = yield* list(input.threadId);
      const terminalId =
        input.terminalId ?? nextTerminalId(existing.map((terminal) => terminal.terminalId));
      const alreadyRunning = existing.some(
        (terminal) => terminal.terminalId === terminalId && terminal.status === "running",
      );
      const project = yield* projects.getById(input.projectId);
      if (Option.isNone(project)) {
        return yield* new ThreadTerminalProjectNotFoundError({ projectId: input.projectId });
      }
      // The same launch context the terminal panel uses for a thread.
      const workspaceRoot = project.value.workspaceRoot;
      const snapshot = yield* attachSnapshot({
        threadId: input.threadId,
        terminalId,
        cwd: input.worktreePath ?? workspaceRoot,
        worktreePath: input.worktreePath,
        env: projectScriptRuntimeEnv({
          project: { cwd: workspaceRoot },
          worktreePath: input.worktreePath,
        }),
        restartIfNotRunning: true,
      });
      return { terminalId, status: snapshot.status, alreadyRunning };
    },
    (effect, input) => opens.withLock(input.threadId, effect),
  );

  const write: ThreadTerminals["Service"]["write"] = Effect.fn("ThreadTerminals.write")(
    function* (input) {
      // Check in the manager so an exit after reading metadata cannot drop input silently.
      yield* terminals.write({
        ...input,
        requireRunning: true,
      });
    },
  );

  const close: ThreadTerminals["Service"]["close"] = Effect.fn("ThreadTerminals.close")(
    function* (input) {
      const terminal = yield* find(input.threadId, input.terminalId);
      // Matches closing a terminal in the app, which discards its scrollback.
      yield* terminals.close({
        threadId: input.threadId,
        terminalId: terminal.terminalId,
        deleteHistory: true,
      });
    },
  );

  return ThreadTerminals.of({ list, read, open, write, close });
});

export const layer = Layer.effect(ThreadTerminals, make);
