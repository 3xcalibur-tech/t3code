import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  encodePeerSetupString,
  EnvironmentId,
  PeerGrantId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PeerTargets from "./PeerTargets.ts";
import * as PeerTargetsTestkit from "./PeerTargets.testkit.ts";

const peerUrl = "https://leftbook.example";
const secret = "t3pg_secret";
const environmentId = EnvironmentId.make("environment:leftbook");
const caller: PeerTargets.PeerCaller = {
  requestNamespace: "provider-session:mainbook-agent",
  environmentId: EnvironmentId.make("environment:mainbook"),
  runtimeMode: "auto",
  interactionMode: "default",
};
const launchInput = {
  projectId: ProjectId.make("project:app"),
  prompt: "Check the login page in Safari.",
  code: { ref: "feature/login", commit: "a".repeat(40) },
  clientRequestId: "check-1",
};

/** A fake B that accepts one secret and records what A sends. */
function makePeer() {
  const state = { revoked: false };
  const requests: Array<{ readonly path: string; readonly body: unknown }> = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const layer = PeerTargetsTestkit.layerWithPeer(async (request) => {
    const path = new URL(request.url).pathname;
    const text = await request.text();
    requests.push({ path, body: text.length === 0 ? undefined : JSON.parse(text) });
    if (state.revoked || request.headers.get("authorization") !== `Bearer ${secret}`) {
      return json(401, { _tag: "PeerUnauthorizedError", code: "peer_grant_invalid" });
    }
    switch (path) {
      case "/api/peer/v1/capabilities":
        return json(200, {
          environmentId,
          environmentLabel: "Leftbook",
          grantLabel: "Mainbook",
          projectIds: [],
          maxRuntimeMode: "auto",
          maxInteractionMode: "default",
          runSetupScripts: false,
          providers: [],
        });
      case "/api/peer/v1/launch":
        return json(200, { environmentId, threadId: "thread:b", runId: "run:b" });
      case "/api/peer/v1/wait":
        return json(200, { threadId: "thread:b", runId: null, status: "running", timedOut: true });
      default:
        return json(404, {});
    }
  }).pipe(Layer.provide(NodeCrypto.layer));
  return { requests, layer, state };
}

it.effect("adds a target only after the peer accepts the grant, and keeps its secret", () => {
  const { layer, state } = makePeer();
  return Effect.gen(function* () {
    const targets = yield* PeerTargets.PeerTargets;
    const setupFailure = (setup: string) =>
      targets.add(setup).pipe(
        Effect.flip,
        Effect.map((error) => (error._tag === "PeerTargetSetupError" ? error.reason : error._tag)),
      );
    expect(yield* setupFailure("not a setup string")).toBe("invalid_peer_setup");
    // Plain HTTP is only allowed on loopback.
    expect(
      yield* setupFailure(encodePeerSetupString({ url: "http://leftbook.example", secret })),
    ).toBe("invalid_peer_setup");
    expect(yield* setupFailure(encodePeerSetupString({ url: peerUrl, secret: "t3pg_wrong" }))).toBe(
      "peer_grant_rejected",
    );

    const added = yield* targets.add(encodePeerSetupString({ url: peerUrl, secret }));
    expect(added).toMatchObject({ environmentId, label: "Leftbook", grantLabel: "Mainbook" });
    expect(yield* targets.list).toEqual([added]);
    expect(Object.values((yield* targets.list)[0] ?? {})).not.toContain(secret);

    // Agents see whether each target answers now.
    expect(yield* targets.targetsFor(caller)).toEqual([{ ...added, reachable: true }]);
    state.revoked = true;
    expect(yield* targets.targetsFor(caller)).toEqual([{ ...added, reachable: false }]);
  }).pipe(Effect.provide(layer));
});

it.effect("never lets peer work reach further, or launch broader than its caller", () => {
  const { requests, layer } = makePeer();
  return Effect.gen(function* () {
    const targets = yield* PeerTargets.PeerTargets;
    yield* targets.add(encodePeerSetupString({ url: peerUrl, secret }));
    const sentBefore = requests.length;

    const peerCaller = {
      ...caller,
      peerOrigin: { grantId: PeerGrantId.make("grant:x"), label: "X", claimedEnvironmentId: null },
    };
    expect((yield* targets.targetsFor(peerCaller).pipe(Effect.flip)).code).toBe(
      "capability_denied",
    );
    expect(
      (yield* targets.launch(peerCaller, environmentId, launchInput).pipe(Effect.flip)).code,
    ).toBe("capability_denied");
    expect(
      (yield* targets
        .launch(caller, environmentId, { ...launchInput, runtimeMode: "full-access" })
        .pipe(Effect.flip)).code,
    ).toBe("runtime_mode_escalation_denied");
    expect(requests).toHaveLength(sentBefore);

    yield* targets.launch(caller, environmentId, launchInput);
    yield* targets.launch(
      { ...caller, requestNamespace: "provider-session:other-agent" },
      environmentId,
      launchInput,
    );
    const launches = requests
      .filter((request) => request.path === "/api/peer/v1/launch")
      .map((request) => request.body as Record<string, unknown>);
    expect(launches[0]).toMatchObject({
      callerRuntimeMode: "auto",
      callerInteractionMode: "default",
      sourceEnvironmentId: "environment:mainbook",
    });
    // One key from two agents must not collapse into one launch on the peer.
    expect(launches[0]?.clientRequestId).toMatch(/^[0-9a-f]{64}$/);
    expect(launches[0]?.clientRequestId).not.toBe(launches[1]?.clientRequestId);
  }).pipe(Effect.provide(layer));
});

it.live("waits in bounded polls until the agent's own timeout", () => {
  const { requests, layer } = makePeer();
  return Effect.gen(function* () {
    const targets = yield* PeerTargets.PeerTargets;
    yield* targets.add(encodePeerSetupString({ url: peerUrl, secret }));
    const result = yield* targets.wait(caller, environmentId, {
      threadId: ThreadId.make("thread:b"),
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    const waits = requests.filter((request) => request.path === "/api/peer/v1/wait");
    expect(waits.length).toBeGreaterThan(0);
    for (const wait of waits) {
      expect((wait.body as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(50);
    }
  }).pipe(Effect.provide(layer));
});
