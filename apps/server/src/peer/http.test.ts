import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  encodePeerSetupString,
  EnvironmentHttpApi,
  EnvironmentId,
  type PeerGrant,
  PeerGrantId,
  PeerRequestError,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as PeerGrants from "./PeerGrants.ts";
import * as PeerService from "./PeerService.ts";
import * as PeerTargets from "./PeerTargets.ts";
import * as PeerTargetsTestkit from "./PeerTargets.testkit.ts";
import { peerGrantAuthLayer, peerHttpApiLayer } from "./http.ts";

class PeerTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.peer) {}

const SECRET = "t3pg_test-secret";
const grant: PeerGrant = {
  id: PeerGrantId.make("grant:test"),
  label: "Mainbook",
  projectIds: [ProjectId.make("project:test")],
  maxRuntimeMode: "auto",
  maxInteractionMode: "default",
  runSetupScripts: false,
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
  lastUsedAt: null,
};

/** B's real peer routes over a mocked grant store and peer service. */
function makePeerRoutes(state: { revoked: boolean }) {
  return HttpApiBuilder.layer(PeerTestApi).pipe(
    Layer.provide(peerHttpApiLayer),
    Layer.provide(peerGrantAuthLayer),
    Layer.provide(
      Layer.mock(PeerGrants.PeerGrants)({
        authenticate: (secret) =>
          Effect.succeed(secret === SECRET && !state.revoked ? Option.some(grant) : Option.none()),
      }),
    ),
    Layer.provide(
      Layer.mock(PeerService.PeerService)({
        capabilities: (current) =>
          Effect.succeed({
            environmentId: EnvironmentId.make("environment:b"),
            environmentLabel: "Leftbook",
            grantLabel: current.label,
            projectIds: current.projectIds,
            maxRuntimeMode: current.maxRuntimeMode,
            maxInteractionMode: current.maxInteractionMode,
            runSetupScripts: current.runSetupScripts,
            providers: [],
          }),
        launch: (_grant, input) =>
          input.code.ref === "missing"
            ? Effect.fail(
                new PeerRequestError({ code: "code_unavailable", detail: "Push it first." }),
              )
            : Effect.succeed({
                environmentId: EnvironmentId.make("environment:b"),
                threadId: ThreadId.make("thread:b"),
                runId: RunId.make("run:b"),
              }),
      }),
    ),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
  );
}

it.effect("looks the grant up on every request, so a revoke applies to the next call", () =>
  Effect.gen(function* () {
    const state = { revoked: false };
    const capabilities = (authorization?: string) =>
      new Request("http://127.0.0.1/api/peer/v1/capabilities", {
        method: "POST",
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      });

    yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(makePeerRoutes(state), { disableLogger: true })),
      (web) =>
        Effect.promise(async () => {
          const context = Context.empty();
          expect((await web.handler(capabilities(), context)).status).toBe(401);
          expect((await web.handler(capabilities("Bearer wrong"), context)).status).toBe(401);

          const ok = await web.handler(capabilities(`Bearer ${SECRET}`), context);
          expect(ok.status).toBe(200);
          expect(await ok.json()).toMatchObject({ grantLabel: "Mainbook" });

          state.revoked = true;
          expect((await web.handler(capabilities(`Bearer ${SECRET}`), context)).status).toBe(401);
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("A's client and B's peer routes agree on results and errors", () =>
  Effect.gen(function* () {
    const state = { revoked: false };
    const web = HttpRouter.toWebHandler(makePeerRoutes(state), { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
    const targetsLayer = PeerTargetsTestkit.layerWithPeer((request) =>
      web.handler(request, Context.empty()),
    ).pipe(Layer.provide(NodeCrypto.layer));
    const caller: PeerTargets.PeerCaller = {
      requestNamespace: "provider-session:a",
      environmentId: EnvironmentId.make("environment:a"),
      runtimeMode: "auto",
      interactionMode: "default",
    };
    const launch = {
      projectId: grant.projectIds[0]!,
      prompt: "Check it.",
      code: { ref: "main", commit: "b".repeat(40) },
    };

    yield* Effect.gen(function* () {
      const targets = yield* PeerTargets.PeerTargets;
      const target = yield* targets.add(
        encodePeerSetupString({ url: "https://leftbook.example", secret: SECRET }),
      );
      expect(target).toMatchObject({ environmentId: "environment:b", grantLabel: "Mainbook" });

      expect(yield* targets.launch(caller, target.environmentId, launch)).toEqual({
        environmentId: "environment:b",
        threadId: "thread:b",
        runId: "run:b",
      });
      const rejected = yield* targets
        .launch(caller, target.environmentId, {
          ...launch,
          code: { ...launch.code, ref: "missing" },
        })
        .pipe(Effect.flip);
      expect(rejected).toMatchObject({
        code: "invalid_request",
        detail: "Peer environment: Push it first.",
      });

      state.revoked = true;
      const revoked = yield* targets.launch(caller, target.environmentId, launch).pipe(Effect.flip);
      expect(revoked.code).toBe("capability_denied");
    }).pipe(Effect.provide(targetsLayer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
