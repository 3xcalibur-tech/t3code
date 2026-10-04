import {
  CommandId,
  type GitManagerServiceError,
  type GitRunStackedActionResult,
  type GitStackedAction,
  ProjectId,
  type ThreadId,
  type VcsPullResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import { linkCreatedPullRequest } from "./linkCreatedPullRequest.ts";

class GitThreadProjectLookupError extends Schema.TaggedError<GitThreadProjectLookupError>()(
  "GitThreadProjectLookupError",
  {
    projectId: ProjectId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to look up project ${this.projectId}.`;
  }
}

class GitThreadProjectNotFoundError extends Schema.TaggedError<GitThreadProjectNotFoundError>()(
  "GitThreadProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "The project was not found.";
  }
}

class GitThreadBranchRequiredError extends Schema.TaggedError<GitThreadBranchRequiredError>()(
  "GitThreadBranchRequiredError",
  { action: Schema.Literals(["create_branch", "switch_branch"]) },
) {
  override get message(): string {
    return `Pass branch for ${this.action}.`;
  }
}

/** The thread fields that locate its checkout: its worktree, else the project folder. */
type ThreadCheckout = {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
};

type GitThreadAction = "create_branch" | "switch_branch" | "pull" | GitStackedAction;

/** Git status and actions on a thread's checkout, with the follow-ups the branch toolbar runs. */
export class GitThreadService extends Context.Service<
  GitThreadService,
  {
    /** Refreshes local status (cheap, changes under the agent) and reads the cached full status. */
    readonly status: (
      thread: ThreadCheckout,
    ) => Effect.Effect<
      { readonly cwd: string; readonly status: VcsStatusResult },
      GitThreadProjectLookupError | GitThreadProjectNotFoundError | GitManagerServiceError
    >;
    /**
     * Runs a git action in the thread's checkout, records a new branch on the thread, links a
     * created pull request, and refreshes pull request and git status before returning.
     */
    readonly runAction: (input: {
      readonly thread: ThreadCheckout & { readonly id: ThreadId };
      readonly action: GitThreadAction;
      readonly branch?: string | undefined;
      readonly commitMessage?: string | undefined;
      readonly featureBranch?: boolean | undefined;
      readonly filePaths?: ReadonlyArray<string> | undefined;
    }) => Effect.Effect<
      {
        /** The checked-out branch after the action, when it changed or was created. */
        readonly branch: string | null;
        readonly pull: VcsPullResult | null;
        readonly steps: Pick<GitRunStackedActionResult, "branch" | "commit" | "push" | "pr"> | null;
      },
      | GitThreadProjectLookupError
      | GitThreadProjectNotFoundError
      | GitThreadBranchRequiredError
      | GitManagerServiceError
    >;
  }
>()("t3/git/GitThreadService") {}

type RunActionInput = Parameters<GitThreadService["Service"]["runAction"]>[0];

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const vcs = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const pullRequests = yield* PullRequestService.PullRequestService;

  const newId = crypto.randomUUIDv4.pipe(
    Effect.orDie,
    Effect.map((uuid) => `mcp:${uuid}`),
  );
  const newCommandId = newId.pipe(Effect.map(CommandId.make));

  const checkoutOf = Effect.fn("GitThreadService.checkoutOf")(function* (thread: ThreadCheckout) {
    const project = yield* projects
      .getById(thread.projectId)
      .pipe(
        Effect.mapError(
          (cause) => new GitThreadProjectLookupError({ projectId: thread.projectId, cause }),
        ),
      );
    if (Option.isNone(project)) {
      return yield* new GitThreadProjectNotFoundError({ projectId: thread.projectId });
    }
    return thread.worktreePath ?? project.value.workspaceRoot;
  });

  // The branch toolbar records a new checkout on the thread; do the same so its label is current.
  const recordBranch = (threadId: ThreadId, branch: string) =>
    newCommandId.pipe(
      Effect.flatMap((commandId) =>
        threads.dispatch({ type: "thread.metadata.update", commandId, threadId, branch }),
      ),
      Effect.ignore({ log: true }),
    );

  const status = Effect.fn("GitThreadService.status")(function* (thread: ThreadCheckout) {
    const cwd = yield* checkoutOf(thread);
    // Remote counts come from the cache, which fetches once per checkout like the branch toolbar.
    yield* vcs.refreshLocalStatus(cwd);
    return { cwd, status: yield* vcs.getStatus({ cwd }) };
  });

  const act = Effect.fn("GitThreadService.act")(function* (cwd: string, input: RunActionInput) {
    const { thread } = input;
    switch (input.action) {
      case "create_branch":
      case "switch_branch": {
        if (input.branch === undefined) {
          return yield* new GitThreadBranchRequiredError({ action: input.action });
        }
        const branch =
          input.action === "create_branch"
            ? (yield* git.createRef({ cwd, refName: input.branch, switchRef: true })).refName
            : ((yield* git.switchRef({ cwd, refName: input.branch })).refName ?? input.branch);
        yield* recordBranch(thread.id, branch);
        return { branch, pull: null, steps: null };
      }
      case "pull": {
        const pull = yield* git.pullCurrentBranch(cwd);
        return { branch: null, pull, steps: null };
      }
      default: {
        const result = yield* git.runStackedAction({
          actionId: yield* newId,
          cwd,
          action: input.action,
          threadId: thread.id,
          projectId: thread.projectId,
          ...(input.commitMessage === undefined ? {} : { commitMessage: input.commitMessage }),
          ...(input.featureBranch === undefined ? {} : { featureBranch: input.featureBranch }),
          ...(input.filePaths === undefined ? {} : { filePaths: input.filePaths }),
        });
        // The same follow-ups ws.ts runs after git.runStackedAction.
        yield* linkCreatedPullRequest({
          threadId: thread.id,
          result,
          commandId: newCommandId,
        }).pipe(
          Effect.provideService(Orchestrator.OrchestratorV2, engine),
          Effect.provideService(ProjectService.ProjectService, projects),
        );
        if (result.push.status === "pushed") yield* pullRequests.refreshAfterTurn(thread.projectId);
        const branch = result.branch.status === "created" ? (result.branch.name ?? null) : null;
        if (branch !== null) yield* recordBranch(thread.id, branch);
        const steps = {
          branch: result.branch,
          commit: result.commit,
          push: result.push,
          pr: result.pr,
        };
        return { branch, pull: null, steps };
      }
    }
  });

  const runAction = Effect.fn("GitThreadService.runAction")(function* (input: RunActionInput) {
    const cwd = yield* checkoutOf(input.thread);
    const result = yield* act(cwd, input);
    // Awaited so an immediate status read sees the action's branch state.
    yield* vcs.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    return result;
  });

  return GitThreadService.of({ status, runAction });
});

export const layer = Layer.effect(GitThreadService, make);
