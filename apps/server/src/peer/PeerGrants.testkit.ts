import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as PeerGrants from "./PeerGrants.ts";

/** A grant store with no grants, for tests whose subject is not peer access. */
export const layerNoGrants = Layer.succeed(
  PeerGrants.PeerGrants,
  PeerGrants.PeerGrants.of({
    list: Effect.succeed([]),
    create: () => Effect.die("PeerGrants.create is not available in this test."),
    revoke: () => Effect.succeed(false),
    authenticate: () => Effect.succeedNone,
    getActive: () => Effect.succeed(Option.none()),
    claimLaunch: (_grantId, _threadId, fingerprint) => Effect.succeed(fingerprint),
    launchFingerprint: () => Effect.succeed(Option.none()),
    launchedBy: () => Effect.succeed(false),
    allowsSetupScript: () => Effect.succeed(true),
  }),
);
