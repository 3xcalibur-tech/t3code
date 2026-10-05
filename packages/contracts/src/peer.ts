import * as Context from "effect/Context";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  EnvironmentId,
  PeerGrantId,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  OrchestratorMcpProviderCapability,
  OrchestratorMcpTarget,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitResult,
} from "./orchestratorMcp.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/**
 * Peer access lets agents in one environment (A) start and follow threads in
 * another environment (B). An admin on B creates a grant; A holds its secret
 * and calls B's small peer API. See docs/internals/peer-access.md.
 */

/** Longest wait a single peer `wait` request may hold open. */
export const PEER_WAIT_MAX_MS = 30_000;

/** A grant on B, as admins see it. The secret is only returned once, at creation. */
export const PeerGrant = Schema.Struct({
  id: PeerGrantId,
  label: TrimmedNonEmptyString,
  projectIds: Schema.Array(ProjectId),
  maxRuntimeMode: RuntimeMode,
  maxInteractionMode: ProviderInteractionMode,
  /** When false, project setup scripts never run for threads this grant starts. */
  runSetupScripts: Schema.Boolean,
  createdAt: Schema.DateTimeUtc,
  lastUsedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type PeerGrant = typeof PeerGrant.Type;

export const PeerGrantCreateInput = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  projectIds: Schema.NonEmptyArray(ProjectId),
  maxRuntimeMode: RuntimeMode,
  maxInteractionMode: ProviderInteractionMode,
  runSetupScripts: Schema.Boolean,
});
export type PeerGrantCreateInput = typeof PeerGrantCreateInput.Type;

export const PeerGrantCreateResult = Schema.Struct({
  grant: PeerGrant,
  secret: TrimmedNonEmptyString,
});
export type PeerGrantCreateResult = typeof PeerGrantCreateResult.Type;

export const PeerGrantRevokeInput = Schema.Struct({ id: PeerGrantId });
export const PeerGrantRevokeResult = Schema.Struct({ revoked: Schema.Boolean });

/** An environment that A's agents can hand work to. Stored on A; the secret never leaves A. */
export const PeerTarget = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  url: TrimmedNonEmptyString,
  grantLabel: Schema.String,
  addedAt: Schema.DateTimeUtc,
});
export type PeerTarget = typeof PeerTarget.Type;

export const PeerTargetAddInput = Schema.Struct({ setup: TrimmedNonEmptyString });
export const PeerTargetRemoveInput = Schema.Struct({ environmentId: EnvironmentId });
export const PeerTargetRemoveResult = Schema.Struct({ removed: Schema.Boolean });

const PEER_SETUP_PREFIX = "t3peer1.";

const PeerSetup = Schema.Struct({ url: TrimmedNonEmptyString, secret: TrimmedNonEmptyString });
export type PeerSetup = typeof PeerSetup.Type;
const decodePeerSetupJson = Schema.decodeUnknownOption(Schema.fromJsonString(PeerSetup));

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Peer endpoints must use HTTPS. Plain HTTP is only accepted for loopback, so
 * two servers on one machine can pair in development.
 */
export function isAllowedPeerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
    );
  } catch {
    return false;
  }
}

/** The one-time string an admin copies from B and pastes into A. */
export function encodePeerSetupString(setup: PeerSetup): string {
  return `${PEER_SETUP_PREFIX}${Encoding.encodeBase64Url(JSON.stringify(setup))}`;
}

export function decodePeerSetupString(text: string): PeerSetup | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PEER_SETUP_PREFIX)) return null;
  const json = Encoding.decodeBase64UrlString(trimmed.slice(PEER_SETUP_PREFIX.length));
  if (Result.isFailure(json)) return null;
  const setup = decodePeerSetupJson(json.success);
  return setup._tag === "Some" && isAllowedPeerUrl(setup.value.url) ? setup.value : null;
}

/** What B lets this grant do, plus B's providers so A's agent can pick a model. */
export const PeerCapabilities = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: Schema.String,
  grantLabel: Schema.String,
  projectIds: Schema.Array(ProjectId),
  maxRuntimeMode: RuntimeMode,
  maxInteractionMode: ProviderInteractionMode,
  runSetupScripts: Schema.Boolean,
  providers: Schema.Array(OrchestratorMcpProviderCapability),
});
export type PeerCapabilities = typeof PeerCapabilities.Type;

export const PeerProjectsResult = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ id: ProjectId, title: Schema.String })),
});
export type PeerProjectsResult = typeof PeerProjectsResult.Type;

const GitCommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/));
/** A branch name. No leading dash, so a value can never be read as a git option. */
const GitBranchName = TrimmedNonEmptyString.check(Schema.isMaxLength(255)).check(
  Schema.isPattern(/^(?!-)(?!refs\/)[A-Za-z0-9._/-]+$/),
);
const GitRemoteName = TrimmedNonEmptyString.check(Schema.isMaxLength(100)).check(
  Schema.isPattern(/^(?!-)[A-Za-z0-9._-]+$/),
);

/** Exact code B checks out. A must push first; B never falls back to a local ref. */
export const PeerLaunchCode = Schema.Struct({
  remote: Schema.optional(
    GitRemoteName.annotate({
      description: "Remote name in B's checkout to fetch from. Defaults to origin.",
    }),
  ),
  ref: GitBranchName.annotate({ description: "Branch on the remote that contains the commit." }),
  commit: GitCommitSha.annotate({ description: "Full commit SHA to start the worktree at." }),
});
export type PeerLaunchCode = typeof PeerLaunchCode.Type;

export const PeerLaunchInput = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  projectId: ProjectId,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  code: PeerLaunchCode,
  target: Schema.optional(OrchestratorMcpTarget),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  /** The calling agent's own modes on A. B never starts work broader than these. */
  callerRuntimeMode: RuntimeMode,
  callerInteractionMode: ProviderInteractionMode,
  /** A's environment id. A hint for display only; B cannot verify it. */
  sourceEnvironmentId: Schema.optional(EnvironmentId),
});
export type PeerLaunchInput = typeof PeerLaunchInput.Type;

export const PeerLaunchResult = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  runId: RunId,
});
export type PeerLaunchResult = typeof PeerLaunchResult.Type;

export const PeerReadInput = OrchestratorMcpThreadReadInput;
export type PeerReadInput = typeof PeerReadInput.Type;

export const PeerWaitInput = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  timeoutMs: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(PEER_WAIT_MAX_MS))),
});
export type PeerWaitInput = typeof PeerWaitInput.Type;

export const PeerInterruptInput = OrchestratorMcpThreadInterruptInput;
export type PeerInterruptInput = typeof PeerInterruptInput.Type;

export class PeerUnauthorizedError extends Schema.TaggedError<PeerUnauthorizedError>()(
  "PeerUnauthorizedError",
  { code: Schema.Literal("peer_grant_invalid") },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PeerUnauthorizedError)(this, { status: 401 });
  }

  override get message(): string {
    return "The peer grant is missing, unknown, or revoked.";
  }
}

export const PeerRequestErrorCode = Schema.Literals([
  "invalid_request",
  "project_not_granted",
  "thread_not_granted",
  "code_unavailable",
  "provider_unavailable",
  "model_unavailable",
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
  "unavailable",
]);
export type PeerRequestErrorCode = typeof PeerRequestErrorCode.Type;

/** B refused or could not complete a peer request. The message is safe to show to A's agent. */
export class PeerRequestError extends Schema.TaggedError<PeerRequestError>()(
  "PeerRequestError",
  { code: PeerRequestErrorCode, detail: Schema.String },
  { httpApiStatus: 422 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PeerRequestError)(this, { status: 422 });
  }

  override get message(): string {
    return this.detail;
  }
}

/** The grant that authenticated the current peer request. */
export class PeerGrantPrincipal extends Context.Service<PeerGrantPrincipal, PeerGrant>()(
  "@t3tools/contracts/peer/PeerGrantPrincipal",
) {}

export class PeerGrantAuth extends HttpApiMiddleware.Service<
  PeerGrantAuth,
  { provides: PeerGrantPrincipal }
>()("PeerGrantAuth", { error: [PeerUnauthorizedError] }) {}

const PeerHeaders = Schema.Struct({ authorization: Schema.optionalKey(Schema.String) });
const PeerErrors = [PeerRequestError] as const;

/** B's peer API. Every request is authenticated by a grant secret, looked up per request. */
export class PeerHttpApiGroup extends HttpApiGroup.make("peer")
  .add(
    HttpApiEndpoint.post("capabilities", "/api/peer/v1/capabilities", {
      headers: PeerHeaders,
      success: PeerCapabilities,
      error: PeerErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("projects", "/api/peer/v1/projects", {
      headers: PeerHeaders,
      success: PeerProjectsResult,
      error: PeerErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("launch", "/api/peer/v1/launch", {
      headers: PeerHeaders,
      payload: PeerLaunchInput,
      success: PeerLaunchResult,
      error: PeerErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("read", "/api/peer/v1/read", {
      headers: PeerHeaders,
      payload: PeerReadInput,
      success: OrchestratorMcpThreadReadResult,
      error: PeerErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("wait", "/api/peer/v1/wait", {
      headers: PeerHeaders,
      payload: PeerWaitInput,
      success: OrchestratorMcpThreadWaitResult,
      error: PeerErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("interrupt", "/api/peer/v1/interrupt", {
      headers: PeerHeaders,
      payload: PeerInterruptInput,
      success: OrchestratorMcpThreadInterruptResult,
      error: PeerErrors,
    }),
  )
  .middleware(PeerGrantAuth) {}
