import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  PeerGrantAuth,
  PeerGrantPrincipal,
  PeerUnauthorizedError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as PeerGrants from "./PeerGrants.ts";
import * as PeerService from "./PeerService.ts";
import * as PeerTargets from "./PeerTargets.ts";

const BEARER_PREFIX = "Bearer ";

/** Looks the grant up on every request, so a revoke applies to the next call. */
export const peerGrantAuthLayer = Layer.effect(
  PeerGrantAuth,
  Effect.gen(function* () {
    const grants = yield* PeerGrants.PeerGrants;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const header = request.headers.authorization;
        const secret = header?.startsWith(BEARER_PREFIX)
          ? header.slice(BEARER_PREFIX.length).trim()
          : "";
        const grant = secret.length === 0 ? Option.none() : yield* grants.authenticate(secret);
        if (Option.isNone(grant)) {
          return yield* new PeerUnauthorizedError({ code: "peer_grant_invalid" });
        }
        return yield* httpEffect.pipe(Effect.provideService(PeerGrantPrincipal, grant.value));
      }).pipe(
        Effect.catchTag("PeerGrantStoreError", (error) =>
          Effect.logError("peer grant lookup failed", { cause: error }).pipe(
            Effect.andThen(Effect.fail(new PeerUnauthorizedError({ code: "peer_grant_invalid" }))),
          ),
        ),
      );
  }),
);

export const peerHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "peer",
  Effect.fnUntraced(function* (handlers) {
    const peer = yield* PeerService.PeerService;
    return handlers
      .handle("capabilities", () => PeerGrantPrincipal.pipe(Effect.flatMap(peer.capabilities)))
      .handle("projects", () => PeerGrantPrincipal.pipe(Effect.flatMap(peer.projects)))
      .handle("launch", (args) =>
        PeerGrantPrincipal.pipe(Effect.flatMap((grant) => peer.launch(grant, args.payload))),
      )
      .handle("read", (args) =>
        PeerGrantPrincipal.pipe(Effect.flatMap((grant) => peer.read(grant, args.payload))),
      )
      .handle("wait", (args) =>
        PeerGrantPrincipal.pipe(Effect.flatMap((grant) => peer.wait(grant, args.payload))),
      )
      .handle("interrupt", (args) =>
        PeerGrantPrincipal.pipe(Effect.flatMap((grant) => peer.interrupt(grant, args.payload))),
      );
  }),
);

export const peerTargetsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "peerTargets",
  Effect.fnUntraced(function* (handlers) {
    const targets = yield* PeerTargets.PeerTargets;
    return handlers
      .handle(
        "list",
        Effect.fn("environment.peerTargets.list")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            return yield* targets.list;
          },
          Effect.catchTag("PeerTargetStoreError", (error) =>
            failEnvironmentInternal("peer_targets_failed", error),
          ),
        ),
      )
      .handle(
        "add",
        Effect.fn("environment.peerTargets.add")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
            return yield* targets.add(args.payload.setup);
          },
          Effect.catchTags({
            PeerTargetSetupError: (error) => failEnvironmentInvalidRequest(error.reason),
            PeerTargetStoreError: (error) => failEnvironmentInternal("peer_targets_failed", error),
          }),
        ),
      )
      .handle(
        "remove",
        Effect.fn("environment.peerTargets.remove")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
            return { removed: yield* targets.remove(args.payload.environmentId) };
          },
          Effect.catchTag("PeerTargetStoreError", (error) =>
            failEnvironmentInternal("peer_targets_failed", error),
          ),
        ),
      );
  }),
);
