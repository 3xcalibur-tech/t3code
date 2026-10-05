import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PeerTargets from "./PeerTargets.ts";

/**
 * The real target service over an in-memory secret store and a fake peer.
 * `peer` answers each request the service sends to the other environment.
 */
export const layerWithPeer = (peer: (request: Request) => Response | Promise<Response>) => {
  const secrets = new Map<string, Uint8Array>();
  return PeerTargets.layer.pipe(
    Layer.provide(
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
          set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
          create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
          getOrCreateRandom: () => Effect.die("Not used by peer targets."),
          remove: (name) => Effect.sync(() => void secrets.delete(name)),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request, url) =>
          Effect.promise(async () => {
            const body = request.body._tag === "Uint8Array" ? request.body.body : undefined;
            const response = await peer(
              new Request(url, {
                method: request.method,
                headers: request.headers,
                ...(body === undefined ? {} : { body }),
              }),
            );
            return HttpClientResponse.fromWeb(request, response);
          }),
        ),
      ),
    ),
  );
};
