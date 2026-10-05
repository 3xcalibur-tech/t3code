import * as NodeCrypto from "node:crypto";

import {
  decodePeerSetupString,
  EnvironmentHttpApi,
  EnvironmentId,
  isAllowedPeerUrl,
  type OrchestrationV2PeerOrigin,
  type OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadWaitResult,
  type PeerCapabilities,
  type PeerInterruptInput,
  type PeerLaunchInput,
  type PeerLaunchResult,
  type PeerProjectsResult,
  type PeerReadInput,
  PeerTarget,
  PEER_WAIT_MAX_MS,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";

/** All targets live in one secret, so the grant secrets never touch the database. */
const TARGETS_SECRET = "peer-targets";
/** How long one call to B may take. A launch fetches git, so it gets the most. */
const PEER_CALL_TIMEOUT = Duration.seconds(120);
/** A reachability probe answers "is it up now", so it must not hold the agent. */
const PEER_PROBE_TIMEOUT = Duration.seconds(5);
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;

const StoredTarget = Schema.Struct({
  ...PeerTarget.fields,
  addedAt: Schema.DateTimeUtcFromString,
  secret: Schema.String,
});
type StoredTarget = typeof StoredTarget.Type;
const StoredTargets = Schema.fromJsonString(Schema.Array(StoredTarget));
const decodeStoredTargets = Schema.decodeUnknownEffect(StoredTargets);
const encodeStoredTargets = Schema.encodeEffect(StoredTargets);

export class PeerTargetStoreError extends Schema.TaggedError<PeerTargetStoreError>()(
  "PeerTargetStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Peer target ${this.operation} failed.`;
  }
}

export class PeerTargetSetupError extends Schema.TaggedError<PeerTargetSetupError>()(
  "PeerTargetSetupError",
  { reason: Schema.Literals(["invalid_peer_setup", "peer_grant_rejected", "peer_unreachable"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid_peer_setup":
        return "That is not a valid peer setup string.";
      case "peer_grant_rejected":
        return "The other environment rejected this grant. It may have been revoked.";
      case "peer_unreachable":
        return "The other environment could not be reached at that address.";
    }
  }
}

/** Why an agent's call to a peer failed. Codes match the MCP failure codes the agent sees. */
export class PeerCallError extends Schema.TaggedError<PeerCallError>()("PeerCallError", {
  code: Schema.Literals([
    "capability_denied",
    "invalid_request",
    "provider_unavailable",
    "model_unavailable",
    "runtime_mode_escalation_denied",
    "interaction_mode_escalation_denied",
    "orchestration_error",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** The agent on this environment that is calling a peer: a T3 thread or an outside MCP client. */
export interface PeerCaller {
  /** Unique per calling thread or client; scopes request keys so callers cannot collide. */
  readonly requestNamespace: string;
  readonly environmentId: EnvironmentId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly peerOrigin?: OrchestrationV2PeerOrigin | null | undefined;
}

export type PeerTargetLaunchInput = Omit<
  PeerLaunchInput,
  "clientRequestId" | "callerRuntimeMode" | "callerInteractionMode" | "sourceEnvironmentId"
> & { readonly clientRequestId?: string | undefined };

export interface PeerTargetWaitInput {
  readonly threadId: ThreadId;
  readonly runId?: RunId | undefined;
  readonly timeoutMs?: number | undefined;
}

const makePeerClient = (input: { readonly url: string; readonly secret: string }) =>
  Effect.gen(function* () {
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${input.secret}`)),
    );
    return yield* HttpApiClient.group(EnvironmentHttpApi, {
      group: "peer",
      httpClient,
      baseUrl: input.url,
    });
  });

type PeerClient = Effect.Success<ReturnType<typeof makePeerClient>>;
type PeerClientError = Effect.Error<ReturnType<PeerClient["capabilities"]>>;

const PASSTHROUGH_CODES = new Set<string>([
  "invalid_request",
  "provider_unavailable",
  "model_unavailable",
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
]);

/**
 * Environments this environment's agents can hand work to, and the calls they
 * make. A target is added by pasting a setup string an admin created on the
 * other environment. Agent calls enforce the A-side rules: peer-origin work
 * never reaches further, and modes are never broader than the caller's.
 */
export class PeerTargets extends Context.Service<
  PeerTargets,
  {
    readonly list: Effect.Effect<ReadonlyArray<PeerTarget>, PeerTargetStoreError>;
    readonly add: (
      setup: string,
    ) => Effect.Effect<PeerTarget, PeerTargetStoreError | PeerTargetSetupError>;
    readonly remove: (environmentId: EnvironmentId) => Effect.Effect<boolean, PeerTargetStoreError>;
    /** Stored targets, each probed once so the agent sees which ones answer now. */
    readonly targetsFor: (
      caller: PeerCaller,
    ) => Effect.Effect<ReadonlyArray<PeerTarget & { readonly reachable: boolean }>, PeerCallError>;
    readonly capabilities: (
      caller: PeerCaller,
      environmentId: EnvironmentId,
    ) => Effect.Effect<PeerCapabilities, PeerCallError>;
    readonly projects: (
      caller: PeerCaller,
      environmentId: EnvironmentId,
    ) => Effect.Effect<PeerProjectsResult, PeerCallError>;
    readonly launch: (
      caller: PeerCaller,
      environmentId: EnvironmentId,
      input: PeerTargetLaunchInput,
    ) => Effect.Effect<PeerLaunchResult, PeerCallError>;
    readonly read: (
      caller: PeerCaller,
      environmentId: EnvironmentId,
      input: PeerReadInput,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, PeerCallError>;
    /** Long-polls the peer in bounded steps, so a revoked grant stops a wait within one step. */
    readonly wait: (
      caller: PeerCaller,
      environmentId: EnvironmentId,
      input: PeerTargetWaitInput,
    ) => Effect.Effect<OrchestratorMcpThreadWaitResult, PeerCallError>;
    readonly interrupt: (
      caller: PeerCaller,
      environmentId: EnvironmentId,
      input: PeerInterruptInput,
    ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, PeerCallError>;
  }
>()("t3/peer/PeerTargets") {}

function publicTarget({ secret: _secret, ...target }: StoredTarget): PeerTarget {
  return target;
}

/**
 * The peer dedupes request keys per grant, so scope each key to the caller:
 * two agents here reusing one key must not collapse into one request.
 */
function scopedRequestKey(caller: PeerCaller, key: string): string {
  return NodeCrypto.createHash("sha256").update(`${caller.requestNamespace}\n${key}`).digest("hex");
}

/** Peer-origin work never reaches further environments, so peer access is never transitive. */
function rejectPeerOrigin(caller: PeerCaller) {
  return caller.peerOrigin != null
    ? Effect.fail(
        new PeerCallError({
          code: "capability_denied",
          detail: "Work a peer environment started cannot hand work to another environment.",
        }),
      )
    : Effect.void;
}

function fromPeerClientError(error: PeerClientError | Cause.TimeoutError): PeerCallError {
  switch (error._tag) {
    case "PeerUnauthorizedError":
      return new PeerCallError({
        code: "capability_denied",
        detail: "The peer environment rejected this grant. It may have been revoked.",
      });
    case "PeerRequestError":
      return new PeerCallError({
        code: PASSTHROUGH_CODES.has(error.code)
          ? (error.code as PeerCallError["code"])
          : "invalid_request",
        detail: `Peer environment: ${error.detail}`,
      });
    default:
      return new PeerCallError({
        code: "orchestration_error",
        detail: "The peer environment could not be reached.",
      });
  }
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const writes = yield* Semaphore.make(1);

  const readAll = secrets.get(TARGETS_SECRET).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<ReadonlyArray<StoredTarget>>([]),
        onSome: (bytes) => decodeStoredTargets(new TextDecoder().decode(bytes)),
      }),
    ),
    Effect.mapError((cause) => new PeerTargetStoreError({ operation: "read", cause })),
  );

  const writeAll = (targets: ReadonlyArray<StoredTarget>) =>
    encodeStoredTargets(targets).pipe(
      Effect.flatMap((json) => secrets.set(TARGETS_SECRET, new TextEncoder().encode(json))),
      Effect.mapError((cause) => new PeerTargetStoreError({ operation: "write", cause })),
    );

  const clientFor = (target: { readonly url: string; readonly secret: string }) =>
    makePeerClient(target).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  /** Runs one call against a stored target and maps every failure for the agent. */
  const call = <A>(
    caller: PeerCaller,
    environmentId: EnvironmentId,
    request: (client: PeerClient) => Effect.Effect<A, PeerClientError>,
  ) =>
    Effect.gen(function* () {
      yield* rejectPeerOrigin(caller);
      const targets = yield* readAll.pipe(
        Effect.mapError(
          () =>
            new PeerCallError({
              code: "orchestration_error",
              detail: "Could not read peer targets.",
            }),
        ),
      );
      const target = targets.find((candidate) => candidate.environmentId === environmentId);
      if (target === undefined) {
        return yield* new PeerCallError({
          code: "invalid_request",
          detail: `No peer environment ${environmentId} is set up here. Call t3_peer_targets.`,
        });
      }
      const client = yield* clientFor(target);
      return yield* request(client).pipe(
        Effect.timeout(PEER_CALL_TIMEOUT),
        Effect.mapError(fromPeerClientError),
      );
    });

  const list: PeerTargets["Service"]["list"] = readAll.pipe(
    Effect.map((targets) => targets.map(publicTarget)),
  );

  const add: PeerTargets["Service"]["add"] = (text) =>
    Effect.gen(function* () {
      const setup = decodePeerSetupString(text);
      if (setup === null || !isAllowedPeerUrl(setup.url)) {
        return yield* new PeerTargetSetupError({ reason: "invalid_peer_setup" });
      }
      // Probe from this server, not the client that pasted the string: this
      // server is the one that must reach the other environment.
      const client = yield* clientFor(setup);
      const capabilities = yield* client.capabilities({ headers: {} }).pipe(
        Effect.timeout(Duration.seconds(15)),
        Effect.mapError(
          (error) =>
            new PeerTargetSetupError({
              reason:
                error._tag === "PeerUnauthorizedError" ? "peer_grant_rejected" : "peer_unreachable",
            }),
        ),
      );
      const target: StoredTarget = {
        environmentId: capabilities.environmentId,
        label: capabilities.environmentLabel,
        url: setup.url,
        grantLabel: capabilities.grantLabel,
        addedAt: yield* DateTime.now,
        secret: setup.secret,
      };
      yield* writes.withPermits(1)(
        readAll.pipe(
          Effect.flatMap((targets) =>
            writeAll([
              ...targets.filter((existing) => existing.environmentId !== target.environmentId),
              target,
            ]),
          ),
        ),
      );
      return publicTarget(target);
    });

  const remove: PeerTargets["Service"]["remove"] = (environmentId) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const targets = yield* readAll;
        const remaining = targets.filter((target) => target.environmentId !== environmentId);
        if (remaining.length === targets.length) return false;
        yield* writeAll(remaining);
        return true;
      }),
    );

  const targetsFor: PeerTargets["Service"]["targetsFor"] = (caller) =>
    Effect.gen(function* () {
      yield* rejectPeerOrigin(caller);
      const targets = yield* readAll.pipe(
        Effect.mapError(
          () =>
            new PeerCallError({
              code: "orchestration_error",
              detail: "Could not read peer targets.",
            }),
        ),
      );
      return yield* Effect.forEach(
        targets,
        (target) =>
          clientFor(target).pipe(
            Effect.flatMap((client) => client.capabilities({ headers: {} })),
            Effect.timeout(PEER_PROBE_TIMEOUT),
            Effect.match({ onFailure: () => false, onSuccess: () => true }),
            Effect.map((reachable) => ({ ...publicTarget(target), reachable })),
          ),
        { concurrency: "unbounded" },
      );
    });

  const launch: PeerTargets["Service"]["launch"] = (caller, environmentId, input) =>
    Effect.gen(function* () {
      // Fail here, with this thread's modes in the message, before the peer clamps again.
      yield* OrchestratorMcp.resolveRuntimeMode(caller.runtimeMode, input.runtimeMode).pipe(
        Effect.mapError(
          (failure) =>
            new PeerCallError({ code: "runtime_mode_escalation_denied", detail: failure.message }),
        ),
      );
      yield* OrchestratorMcp.resolveInteractionMode(
        caller.interactionMode,
        input.interactionMode,
      ).pipe(
        Effect.mapError(
          (failure) =>
            new PeerCallError({
              code: "interaction_mode_escalation_denied",
              detail: failure.message,
            }),
        ),
      );
      const key = input.clientRequestId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const clientRequestId = scopedRequestKey(caller, key);
      return yield* call(caller, environmentId, (client) =>
        client.launch({
          headers: {},
          payload: {
            ...input,
            clientRequestId,
            callerRuntimeMode: caller.runtimeMode,
            callerInteractionMode: caller.interactionMode,
            sourceEnvironmentId: caller.environmentId,
          },
        }),
      );
    });

  const wait: PeerTargets["Service"]["wait"] = (caller, environmentId, input) =>
    Effect.gen(function* () {
      const budget = Math.min(MAX_WAIT_TIMEOUT_MS, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
      const deadline = DateTime.toEpochMillis(yield* DateTime.now) + budget;
      let result: OrchestratorMcpThreadWaitResult;
      do {
        const remaining = Math.max(1, deadline - DateTime.toEpochMillis(yield* DateTime.now));
        result = yield* call(caller, environmentId, (client) =>
          client.wait({
            headers: {},
            payload: {
              threadId: input.threadId,
              ...(input.runId === undefined ? {} : { runId: input.runId }),
              timeoutMs: Math.min(PEER_WAIT_MAX_MS, remaining),
            },
          }),
        );
      } while (result.timedOut && DateTime.toEpochMillis(yield* DateTime.now) < deadline);
      return result;
    });

  return PeerTargets.of({
    list,
    add,
    remove,
    targetsFor,
    capabilities: (caller, environmentId) =>
      call(caller, environmentId, (client) => client.capabilities({ headers: {} })),
    projects: (caller, environmentId) =>
      call(caller, environmentId, (client) => client.projects({ headers: {} })),
    launch,
    read: (caller, environmentId, input) =>
      call(caller, environmentId, (client) => client.read({ headers: {}, payload: input })),
    wait,
    interrupt: (caller, environmentId, { clientRequestId, ...input }) =>
      call(caller, environmentId, (client) =>
        client.interrupt({
          headers: {},
          payload: {
            ...input,
            ...(clientRequestId === undefined
              ? {}
              : { clientRequestId: scopedRequestKey(caller, clientRequestId) }),
          },
        }),
      ),
  });
});

export const layer = Layer.effect(PeerTargets, make);
