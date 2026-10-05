import { type OrchestrationV2PeerOrigin, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

interface WithPeerOrigin {
  readonly peerOrigin?: OrchestrationV2PeerOrigin | null | undefined;
}

/**
 * Work another environment started here (peer origin) may only act on work
 * from the same grant: threads, queued runs, pending requests, scheduled tasks.
 * Grants differ in modes and setup-script permission, so one grant's work must
 * not steer another's. Other callers may act on anything. Reads are not gated.
 */
export function assertPeerWorkAccess(caller: WithPeerOrigin | undefined, target: WithPeerOrigin) {
  const origin = caller?.peerOrigin;
  return origin != null && target.peerOrigin?.grantId !== origin.grantId
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Work a peer environment started can only act on work from the same grant.",
        }),
      )
    : Effect.void;
}

/**
 * Refuses an action that peer-origin work may never take, such as writing
 * persistent project or environment configuration or reaching another environment.
 */
export function rejectPeerOriginCaller(caller: WithPeerOrigin | undefined, action: string) {
  return caller?.peerOrigin != null
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `Work a peer environment started cannot ${action}.`,
        }),
      )
    : Effect.void;
}
