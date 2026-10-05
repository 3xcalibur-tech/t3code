import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PeerTargets from "../../../peer/PeerTargets.ts";
import { readCaller, readMutationCaller } from "../../threadAccess.ts";
import { PeerToolkit } from "./tools.ts";

/**
 * The caller as the peer service sees it, limited to its own modes or, for an
 * outside client, its approved ceiling. Launch and interrupt need a live run.
 */
const peerCaller = (mutation: boolean) =>
  (mutation ? readMutationCaller() : readCaller()).pipe(
    Effect.map(({ scope, caller, limits }): PeerTargets.PeerCaller => ({
      requestNamespace: scope.requestNamespace,
      environmentId: scope.environmentId,
      runtimeMode: limits.runtimeMode,
      interactionMode: limits.interactionMode,
      peerOrigin: caller?.peerOrigin,
    })),
  );

const toFailure = (error: PeerTargets.PeerCallError) =>
  new OrchestratorMcpFailure({ code: error.code, message: error.detail });

const withPeers = <A>(
  mutation: boolean,
  run: (
    peers: PeerTargets.PeerTargets["Service"],
    caller: PeerTargets.PeerCaller,
  ) => Effect.Effect<A, PeerTargets.PeerCallError>,
) =>
  Effect.gen(function* () {
    const caller = yield* peerCaller(mutation);
    const peers = yield* PeerTargets.PeerTargets;
    return yield* run(peers, caller).pipe(Effect.mapError(toFailure));
  });

export const PeerHandlersLive = PeerToolkit.toLayer({
  t3_peer_targets: () =>
    withPeers(false, (peers, caller) =>
      peers.targetsFor(caller).pipe(Effect.map((targets) => ({ targets }))),
    ),
  t3_peer_capabilities: ({ environmentId }) =>
    withPeers(false, (peers, caller) => peers.capabilities(caller, environmentId)),
  t3_peer_projects: ({ environmentId }) =>
    withPeers(false, (peers, caller) => peers.projects(caller, environmentId)),
  t3_peer_launch: ({ environmentId, ...input }) =>
    withPeers(true, (peers, caller) => peers.launch(caller, environmentId, input)),
  t3_peer_read: ({ environmentId, ...input }) =>
    withPeers(false, (peers, caller) => peers.read(caller, environmentId, input)),
  t3_peer_wait: ({ environmentId, ...input }) =>
    withPeers(false, (peers, caller) => peers.wait(caller, environmentId, input)),
  t3_peer_interrupt: ({ environmentId, ...input }) =>
    withPeers(true, (peers, caller) => peers.interrupt(caller, environmentId, input)),
});
