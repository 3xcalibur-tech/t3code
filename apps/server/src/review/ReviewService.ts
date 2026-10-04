import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewDiffPreviewSourceKind,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

/** The checkout has no repository a diff can be read from. */
export class ReviewRepositoryNotFoundError extends Schema.TaggedError<ReviewRepositoryNotFoundError>()(
  "ReviewRepositoryNotFoundError",
  { cwd: Schema.String },
) {
  override get message(): string {
    return "The review checkout is not a repository.";
  }
}

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    /**
     * One source or one file of a diff preview. A file reads branch-range unless source says
     * otherwise, and only the requested source is returned.
     */
    readonly getScopedDiffPreview: (input: {
      readonly cwd: ReviewDiffPreviewInput["cwd"];
      readonly baseRef?: ReviewDiffPreviewInput["baseRef"] | undefined;
      readonly source?: ReviewDiffPreviewSourceKind | undefined;
      readonly file?: NonNullable<ReviewDiffPreviewInput["file"]>["path"] | undefined;
    }) => Effect.Effect<
      ReviewDiffPreviewResult,
      ReviewDiffPreviewError | ReviewRepositoryNotFoundError
    >;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation: "ReviewService.getDiffPreview" | "ReviewService.getDiffFileContents",
    cwd: string,
  ) {
    const [candidate, workspaceRoot, worktreesRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      canonicalizePath(config.worktreesDir),
    ]);

    if (isWithinRoot(candidate, workspaceRoot) || isWithinRoot(candidate, worktreesRoot)) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail:
        operation === "ReviewService.getDiffPreview"
          ? "Review diff preview cwd must stay within the configured workspace root."
          : "Review diff file contents cwd must stay within the configured workspace root.",
    });
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (!getDriverDiffPreview) {
      if (handle.kind === "git") {
        return yield* git.getReviewDiffPreview(input);
      }
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffPreview",
        kind: handle.kind,
        detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
      });
    }

    return yield* getDriverDiffPreview(input);
  });

  const getScopedDiffPreview: ReviewService["Service"]["getScopedDiffPreview"] = Effect.fn(
    "ReviewService.getScopedDiffPreview",
  )(function* (input) {
    // A file request reads a single source; branch-range covers committed and uncommitted work.
    const sourceKind = input.source ?? (input.file === undefined ? undefined : "branch-range");
    const readPreview = (
      baseRef: ReviewDiffPreviewInput["baseRef"],
      file?: ReviewDiffPreviewInput["file"],
    ) =>
      getDiffPreview({
        cwd: input.cwd,
        ...(baseRef === undefined ? {} : { baseRef }),
        ...(file === undefined ? {} : { file }),
      });
    let preview: ReviewDiffPreviewResult;
    if (input.file !== undefined && sourceKind !== undefined) {
      // A renamed file needs its old path, which only the full preview's stats know. The lookup
      // is best effort: a working-tree read must not fail on a branch range it does not need.
      const full = yield* readPreview(input.baseRef).pipe(Effect.orElseSucceed(() => undefined));
      const previousPath =
        full?.sources
          .find((source) => source.kind === sourceKind)
          ?.files?.find((file) => file.path === input.file)?.previousPath ?? null;
      preview = yield* readPreview(input.baseRef, { path: input.file, previousPath, sourceKind });
    } else {
      // The working tree needs no base, so a baseRef the branch range can't use is not passed.
      preview = yield* readPreview(sourceKind === "working-tree" ? undefined : input.baseRef).pipe(
        Effect.catchTags({
          GitCommandError: (error) =>
            // An orphan branch can have a HEAD without sharing history with the default base.
            sourceKind === "working-tree" &&
            error.operation === "GitVcsDriver.resolveReviewMergeBase"
              ? readPreview("HEAD")
              : Effect.fail(error),
        }),
      );
    }
    if (preview.sources.length === 0) {
      return yield* new ReviewRepositoryNotFoundError({ cwd: input.cwd });
    }
    return sourceKind === undefined
      ? preview
      : { ...preview, sources: preview.sources.filter((source) => source.kind === sourceKind) };
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  return ReviewService.of({
    getDiffPreview,
    getScopedDiffPreview,
    getDiffFileContents,
  });
});

export const layer = Layer.effect(ReviewService, make);
