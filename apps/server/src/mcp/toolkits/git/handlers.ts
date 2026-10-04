import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as GitThread from "../../../git/GitThreadService.ts";
import {
  readFullAccessCaller,
  readThread,
  readWritableThread,
  unavailable,
} from "../../threadAccess.ts";
import { GitToolkit, MAX_STATUS_FILES } from "./tools.ts";

export const GitToolkitHandlersLive = GitToolkit.toLayer({
  t3_git_status: (input) =>
    Effect.gen(function* () {
      // A cold status cache fetches, which runs git and its credential helpers on the host.
      yield* readFullAccessCaller("Git status requires a live full-access/default caller.");
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      const gitThreads = yield* GitThread.GitThreadService;
      const { cwd, status } = yield* gitThreads
        .status(thread)
        .pipe(
          Effect.mapError((error) =>
            error._tag === "GitThreadProjectNotFoundError"
              ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
              : unavailable(),
          ),
        );
      return {
        threadId: thread.id,
        cwd,
        isRepo: status.isRepo,
        branch: status.refName,
        isDefaultBranch: status.isDefaultRef,
        hasPrimaryRemote: status.hasPrimaryRemote,
        hasUpstream: status.hasUpstream,
        aheadCount: status.aheadCount,
        behindCount: status.behindCount,
        hasWorkingTreeChanges: status.hasWorkingTreeChanges,
        insertions: status.workingTree.insertions,
        deletions: status.workingTree.deletions,
        files: status.workingTree.files.slice(0, MAX_STATUS_FILES),
        filesTruncated: status.workingTree.files.length > MAX_STATUS_FILES,
        pullRequest: status.pr,
      };
    }),
  t3_git: ({ threadId, ...action }) =>
    Effect.gen(function* () {
      yield* readFullAccessCaller("Git actions require a live full-access/default caller.");
      const {
        projection: { thread },
      } = yield* readWritableThread(threadId);
      const gitThreads = yield* GitThread.GitThreadService;
      const result = yield* gitThreads.runAction({ thread, ...action }).pipe(
        Effect.mapError((error) => {
          switch (error._tag) {
            case "GitThreadProjectLookupError":
              return unavailable();
            case "GitThreadProjectNotFoundError":
            case "GitThreadBranchRequiredError":
              return new OrchestratorMcpFailure({
                code: "invalid_request",
                message: error.message,
              });
            default:
              // Git's own words help an agent recover (a dirty tree, an existing branch); keep them short.
              return new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.message.slice(0, 2000),
              });
          }
        }),
      );
      return { threadId: thread.id, action: action.action, ...result };
    }),
});
