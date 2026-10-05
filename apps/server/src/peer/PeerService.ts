import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  isInteractionModeWithin,
  isRuntimeModeWithin,
  MessageId,
  type ModelSelection,
  type OrchestratorMcpFailure,
  type OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadWaitResult,
  type PeerCapabilities,
  type PeerGrant,
  type PeerInterruptInput,
  type PeerLaunchInput,
  type PeerLaunchResult,
  type PeerProjectsResult,
  type PeerReadInput,
  PeerRequestError,
  type PeerRequestErrorCode,
  type PeerWaitInput,
  PEER_WAIT_MAX_MS,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerGrants from "./PeerGrants.ts";

/**
 * B's side of peer access. Every method takes the grant that authenticated the
 * request and only acts inside it: granted projects, modes no broader than the
 * grant and the calling agent, and only threads this grant launched.
 */
export class PeerService extends Context.Service<
  PeerService,
  {
    readonly capabilities: (grant: PeerGrant) => Effect.Effect<PeerCapabilities, PeerRequestError>;
    readonly projects: (grant: PeerGrant) => Effect.Effect<PeerProjectsResult, PeerRequestError>;
    readonly launch: (
      grant: PeerGrant,
      input: PeerLaunchInput,
    ) => Effect.Effect<PeerLaunchResult, PeerRequestError>;
    readonly read: (
      grant: PeerGrant,
      input: PeerReadInput,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, PeerRequestError>;
    readonly wait: (
      grant: PeerGrant,
      input: PeerWaitInput,
    ) => Effect.Effect<OrchestratorMcpThreadWaitResult, PeerRequestError>;
    readonly interrupt: (
      grant: PeerGrant,
      input: PeerInterruptInput,
    ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, PeerRequestError>;
  }
>()("t3/peer/PeerService") {}

function narrowerRuntimeMode(left: RuntimeMode, right: RuntimeMode): RuntimeMode {
  return isRuntimeModeWithin(left, right) ? left : right;
}

function narrowerInteractionMode(
  left: ProviderInteractionMode,
  right: ProviderInteractionMode,
): ProviderInteractionMode {
  return isInteractionModeWithin(left, right) ? left : right;
}

const PASSTHROUGH_CODES = new Set<string>([
  "invalid_request",
  "provider_unavailable",
  "model_unavailable",
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
]);

function rejected(code: PeerRequestErrorCode, detail: string) {
  return new PeerRequestError({ code, detail });
}

function fromMcpFailure(failure: OrchestratorMcpFailure) {
  return rejected(
    PASSTHROUGH_CODES.has(failure.code) ? (failure.code as PeerRequestErrorCode) : "unavailable",
    failure.message,
  );
}

const unavailable = (detail: string) => (cause: unknown) =>
  Effect.logWarning("peer request failed", { detail, cause }).pipe(
    Effect.andThen(Effect.fail(rejected("unavailable", detail))),
  );

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

/** The parts of a launch request that decide what work runs. */
const LaunchRequestFingerprint = Schema.fromJsonString(
  Schema.Struct({
    projectId: Schema.String,
    prompt: Schema.String,
    title: Schema.NullOr(Schema.String),
    remote: Schema.String,
    ref: Schema.String,
    commit: Schema.String,
    target: Schema.NullOr(Schema.Unknown),
    runtimeMode: Schema.NullOr(Schema.String),
    interactionMode: Schema.NullOr(Schema.String),
  }),
);
const encodeLaunchRequest = Schema.encodeEffect(LaunchRequestFingerprint);

const requestFingerprint = (input: PeerLaunchInput) =>
  encodeLaunchRequest({
    projectId: input.projectId,
    prompt: input.prompt,
    title: input.title ?? null,
    remote: input.code.remote ?? "origin",
    ref: input.code.ref,
    commit: input.code.commit,
    target: input.target ?? null,
    runtimeMode: input.runtimeMode ?? null,
    interactionMode: input.interactionMode ?? null,
  }).pipe(
    Effect.map((json) => NodeCrypto.createHash("sha256").update(json).digest("hex")),
    Effect.orDie,
  );

function launchTitle(input: PeerLaunchInput): string {
  if (input.title !== undefined) return input.title;
  const line = input.prompt.split("\n")[0]?.trim() ?? "";
  return line.length === 0 ? "Peer task" : line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

const make = Effect.gen(function* () {
  const grants = yield* PeerGrants.PeerGrants;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* OrchestratorMcp.OrchestratorMcpService;
  const crypto = yield* Crypto.Crypto;

  /** Read, wait, and interrupt only reach threads this grant launched itself. */
  const requireLaunchedThread = (grant: PeerGrant, threadId: ThreadId) =>
    Effect.gen(function* () {
      const launched = yield* grants
        .launchedBy(grant.id, threadId)
        .pipe(Effect.catch(unavailable("Could not check the thread.")));
      const shell = launched
        ? yield* threads
            .getThreadShell(threadId)
            .pipe(Effect.catch(unavailable("Could not read the thread.")))
        : null;
      if (shell == null || shell.deletedAt !== null) {
        return yield* rejected(
          "thread_not_granted",
          `Thread ${threadId} was not started by this grant.`,
        );
      }
      return shell;
    });

  const capabilities: PeerService["Service"]["capabilities"] = (grant) =>
    Effect.gen(function* () {
      const descriptor = yield* environment.getDescriptor;
      return {
        environmentId: descriptor.environmentId,
        environmentLabel: descriptor.label,
        grantLabel: grant.label,
        projectIds: grant.projectIds,
        maxRuntimeMode: grant.maxRuntimeMode,
        maxInteractionMode: grant.maxInteractionMode,
        runSetupScripts: grant.runSetupScripts,
        providers: yield* orchestrator.peer.providers.pipe(Effect.mapError(fromMcpFailure)),
      };
    });

  const projectsFor: PeerService["Service"]["projects"] = (grant) =>
    Effect.forEach(grant.projectIds, (projectId) =>
      projects
        .getById(projectId)
        .pipe(
          Effect.map(Option.map((project) => ({ id: project.id, title: project.title }))),
          Effect.catch(unavailable("Could not read projects.")),
        ),
    ).pipe(Effect.map((found) => ({ projects: found.flatMap(Option.toArray) })));

  /** The project's default model, else the first provider that can run work now. */
  const defaultModelSelection = (projectId: PeerLaunchInput["projectId"]) =>
    Effect.gen(function* () {
      const project = yield* projects.getById(projectId).pipe(
        Effect.catch(unavailable("Could not read the project.")),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(rejected("project_not_granted", "The project was not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      const current = yield* settings.getSettings.pipe(
        Effect.catch(unavailable("Could not read settings.")),
      );
      const configured = resolveProjectSettings(current, projectId, project).settings
        .defaultModelSelection;
      if (configured !== null) return { project, modelSelection: configured };
      const providers = yield* orchestrator.peer.providers.pipe(Effect.mapError(fromMcpFailure));
      const usable = providers.find(
        (provider) => provider.canRunChildTask && provider.models.length > 0,
      );
      if (usable === undefined) {
        return yield* rejected("provider_unavailable", "No provider can run work here right now.");
      }
      const modelSelection: ModelSelection = {
        instanceId: usable.providerInstanceId,
        model: usable.models[0]!.id,
      };
      return { project, modelSelection };
    });

  /**
   * Checks a new launch and builds its input: modes inside the grant and the
   * caller, a model B can run, and a commit that is on the named remote branch.
   */
  const checkedLaunchInput = (
    grant: PeerGrant,
    input: PeerLaunchInput,
    ids: Pick<ThreadLaunch.ThreadLaunchInput, "commandId" | "threadId">,
    messageId: MessageId,
  ) =>
    Effect.gen(function* () {
      const runtimeMode = yield* OrchestratorMcp.resolveRuntimeMode(
        narrowerRuntimeMode(grant.maxRuntimeMode, input.callerRuntimeMode),
        input.runtimeMode,
      ).pipe(Effect.mapError(fromMcpFailure));
      const interactionMode = yield* OrchestratorMcp.resolveInteractionMode(
        narrowerInteractionMode(grant.maxInteractionMode, input.callerInteractionMode),
        input.interactionMode,
      ).pipe(Effect.mapError(fromMcpFailure));
      const { project, modelSelection: inherited } = yield* defaultModelSelection(input.projectId);
      const modelSelection = yield* orchestrator.peer
        .resolveModelSelection({ inherited, target: input.target })
        .pipe(Effect.mapError(fromMcpFailure));

      // Start at the exact commit A pushed. The strict fetch fails when the
      // remote lacks the branch, so a stale local ref can never stand in.
      const remote = input.code.remote ?? "origin";
      yield* git
        .fetchRemoteTrackingBranch({
          cwd: project.workspaceRoot,
          remoteName: remote,
          remoteBranch: input.code.ref,
        })
        .pipe(
          Effect.mapError(() =>
            rejected("code_unavailable", `Could not fetch ${input.code.ref} from ${remote}.`),
          ),
        );
      const onBranch =
        (yield* git
          .hasCommit({ cwd: project.workspaceRoot, refName: input.code.commit })
          .pipe(Effect.catch(unavailable("Could not check the commit.")))) &&
        (yield* git
          .isAncestor({
            cwd: project.workspaceRoot,
            ancestor: input.code.commit,
            descendant: `refs/remotes/${remote}/${input.code.ref}`,
          })
          .pipe(Effect.catch(unavailable("Could not check the commit."))));
      if (!onBranch) {
        return yield* rejected(
          "code_unavailable",
          `Commit ${input.code.commit} is not on ${remote}/${input.code.ref}. Push it first.`,
        );
      }
      return {
        ...ids,
        projectId: input.projectId,
        title: launchTitle(input),
        generateTitle: input.title === undefined,
        modelSelection,
        runtimeMode,
        interactionMode,
        workspaceStrategy: { type: "worktree", baseRef: input.code.commit, startFromOrigin: false },
        initialMessage: { messageId, text: input.prompt, attachments: [] },
        createdBy: "agent",
        creationSource: "mcp",
        peerOrigin: {
          grantId: grant.id,
          label: grant.label,
          claimedEnvironmentId: input.sourceEnvironmentId ?? null,
        },
      } satisfies ThreadLaunch.ThreadLaunchInput;
    });

  const startLaunch = (launchInput: ThreadLaunch.ThreadLaunchInput, messageId: MessageId) =>
    Effect.gen(function* () {
      const result = yield* launches
        .launch(launchInput)
        .pipe(Effect.catch(unavailable("The thread could not be started.")));
      const run = result.projection.runs.find((candidate) => candidate.userMessageId === messageId);
      if (run === undefined) {
        return yield* rejected("unavailable", "The thread started without a run.");
      }
      const descriptor = yield* environment.getDescriptor;
      return { environmentId: descriptor.environmentId, threadId: result.threadId, runId: run.id };
    });

  const launch: PeerService["Service"]["launch"] = (grant, input) =>
    Effect.gen(function* () {
      if (!grant.projectIds.includes(input.projectId)) {
        return yield* rejected("project_not_granted", "This grant does not cover that project.");
      }
      // Stable ids make a retry find the first launch. The key includes the grant.
      const requestKey = `${stablePart(grant.id)}:${stablePart(input.clientRequestId)}`;
      const ids = {
        commandId: CommandId.make(`peer:${requestKey}`),
        threadId: ThreadId.make(`thread:peer:${requestKey}`),
      };
      const messageId = MessageId.make(`peer-message:${requestKey}`);
      const existing = yield* threads
        .getThreadShell(ids.threadId)
        .pipe(Effect.catch(unavailable("Could not read the thread.")));
      if (existing !== null && existing.peerOrigin?.grantId !== grant.id) {
        return yield* rejected("invalid_request", "That request id belongs to other work.");
      }
      const fingerprint = yield* requestFingerprint(input);
      if (existing === null) {
        const checked = yield* checkedLaunchInput(grant, input, ids, messageId);
        // Two requests can race past the thread check. Only the first claim
        // of this id may start work; a different request for it is refused.
        const claimed = yield* grants
          .claimLaunch(grant.id, ids.threadId, fingerprint)
          .pipe(Effect.catch(unavailable("Could not record the launch.")));
        if (claimed !== fingerprint) {
          return yield* rejected(
            "invalid_request",
            "That request id was already used for a different launch.",
          );
        }
        return yield* startLaunch(checked, messageId);
      }
      // A retry replays the accepted launch without repeating git or provider
      // checks, so it must be the request B checked. The launch service dedupes
      // the create and the message, and resumes preparation if it never finished.
      const recorded = yield* grants
        .launchFingerprint(grant.id, ids.threadId)
        .pipe(Effect.catch(unavailable("Could not read the launch.")));
      if (Option.getOrNull(recorded) !== fingerprint) {
        return yield* rejected(
          "invalid_request",
          "That request id was already used for a different launch.",
        );
      }
      return yield* startLaunch(
        {
          ...ids,
          projectId: existing.projectId,
          title: existing.title,
          modelSelection: existing.modelSelection,
          runtimeMode: existing.runtimeMode,
          interactionMode: existing.interactionMode,
          workspaceStrategy: {
            type: "worktree",
            baseRef: input.code.commit,
            startFromOrigin: false,
          },
          initialMessage: { messageId, text: input.prompt, attachments: [] },
          createdBy: "agent",
          creationSource: "mcp",
          peerOrigin: existing.peerOrigin ?? undefined,
        },
        messageId,
      );
    });

  const read: PeerService["Service"]["read"] = (grant, input) =>
    requireLaunchedThread(grant, input.threadId).pipe(
      Effect.andThen(orchestrator.peer.readThread(input).pipe(Effect.mapError(fromMcpFailure))),
    );

  const wait: PeerService["Service"]["wait"] = (grant, input) =>
    Effect.gen(function* () {
      const shell = yield* requireLaunchedThread(grant, input.threadId);
      const result = yield* threads
        .waitForThread({
          projectId: shell.projectId,
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          timeoutMs: Math.min(PEER_WAIT_MAX_MS, input.timeoutMs ?? PEER_WAIT_MAX_MS),
        })
        .pipe(Effect.catch(unavailable("Could not wait for the thread.")));
      return {
        threadId: input.threadId,
        runId: result.run?.id ?? null,
        status: result.run?.status ?? "idle",
        timedOut: result.timedOut,
      };
    });

  const interrupt: PeerService["Service"]["interrupt"] = (grant, input) =>
    Effect.gen(function* () {
      const shell = yield* requireLaunchedThread(grant, input.threadId);
      const requestKey = input.clientRequestId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const result = yield* threads
        .interruptThread({
          projectId: shell.projectId,
          commandId: CommandId.make(
            `peer:${stablePart(grant.id)}:interrupt:${stablePart(input.threadId)}:${stablePart(requestKey)}`,
          ),
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
        .pipe(Effect.catch(unavailable("Could not interrupt the thread.")));
      if (result.type === "no_active_run") {
        return { threadId: input.threadId, runId: null, status: "no_active_run" as const };
      }
      return {
        threadId: input.threadId,
        runId: result.run.id,
        status:
          result.type === "already_terminal" ? result.run.status : ("interrupt_requested" as const),
      };
    });

  return PeerService.of({
    capabilities,
    projects: projectsFor,
    launch,
    read,
    wait,
    interrupt,
  });
});

export const layer = Layer.effect(PeerService, make);
