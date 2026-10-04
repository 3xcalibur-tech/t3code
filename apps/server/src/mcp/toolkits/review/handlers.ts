import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Project from "../../../project/ProjectService.ts";
import * as Review from "../../../review/ReviewService.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import { ReviewToolkit } from "./tools.ts";

const DEFAULT_DIFF_CHARACTERS = 20_000;

export const ReviewToolkitHandlersLive = ReviewToolkit.toLayer({
  t3_thread_diff: (input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      const projects = yield* Project.ProjectService;
      const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      const review = yield* Review.ReviewService;
      const preview = yield* review
        .getScopedDiffPreview({
          cwd: thread.worktreePath ?? project.value.workspaceRoot,
          baseRef: input.baseRef,
          source: input.source,
          file: input.file,
        })
        .pipe(
          Effect.mapError((error) => {
            switch (error._tag) {
              case "VcsRepositoryDetectionError":
              case "VcsUnsupportedOperationError":
                return new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: error.detail,
                });
              // A baseRef with no common commit with HEAD is the caller's mistake.
              case "GitCommandError":
                return error.operation === "GitVcsDriver.resolveReviewMergeBase"
                  ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail })
                  : unavailable();
              case "ReviewRepositoryNotFoundError":
                return new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "The thread's checkout is not a git repository.",
                });
              default:
                return unavailable();
            }
          }),
        );
      const maxCharacters = input.maxCharacters ?? DEFAULT_DIFF_CHARACTERS;
      return {
        threadId: thread.id,
        cwd: preview.cwd,
        sources: preview.sources.map((source) => ({
          kind: source.kind,
          title: source.title,
          baseRef: source.baseRef,
          headRef: source.headRef,
          files: source.files ?? null,
          diff: source.diff.slice(0, maxCharacters),
          truncated: source.truncated || source.diff.length > maxCharacters,
        })),
      };
    }),
});
