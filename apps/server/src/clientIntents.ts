import type {
  ClientIntent,
  ClientIntentThreadPanel,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

/**
 * Broadcasts requests for connected clients to show something. Each intent
 * names the subscribed window the user focused last, from the existing client
 * activity reports. Clients without a target fall back to whichever is focused.
 */
export class ClientIntents extends Context.Service<
  ClientIntents,
  {
    /** Resolves whether any client was subscribed to receive the request. */
    readonly openThread: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly panel?: ClientIntentThreadPanel;
    }) => Effect.Effect<boolean>;
    readonly reportFocus: (input: {
      readonly environmentId: EnvironmentId;
      readonly clientId: string | undefined;
      readonly focused: boolean;
    }) => Effect.Effect<void>;
    readonly stream: (input: {
      readonly environmentId: EnvironmentId;
      readonly clientId?: string | undefined;
      readonly focused?: boolean | undefined;
    }) => Stream.Stream<ClientIntent>;
  }
>()("t3/clientIntents") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  // Intents are momentary; a client that stops draining keeps only the latest few.
  const pubsub = yield* PubSub.sliding<ClientIntent>(8);
  const subscribers = yield* Ref.make(0);
  const subscriptionLock = yield* Semaphore.make(1);
  let sequence = 0;
  const windows = new Map<
    string,
    {
      environmentId: EnvironmentId;
      clientId: string;
      connectedOrder: number;
      focusedOrder: number;
    }
  >();

  return ClientIntents.of({
    openThread: (input) =>
      Effect.gen(function* () {
        const intentId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        return yield* subscriptionLock.withPermit(
          Effect.gen(function* () {
            const targetClientId = Array.from(windows.values())
              .filter(
                (window) => window.environmentId === input.environmentId && window.focusedOrder > 0,
              )
              .sort(
                (left, right) =>
                  right.focusedOrder - left.focusedOrder ||
                  right.connectedOrder - left.connectedOrder,
              )[0]?.clientId;
            yield* PubSub.publish(pubsub, {
              type: "openThread",
              intentId,
              ...input,
              ...(targetClientId === undefined ? {} : { targetClientId }),
            });
            return (yield* Ref.get(subscribers)) > 0;
          }),
        );
      }),
    reportFocus: (input) =>
      subscriptionLock.withPermit(
        Effect.sync(() => {
          const window =
            input.clientId === undefined
              ? undefined
              : windows.get(`${input.environmentId}\u0000${input.clientId}`);
          if (window && input.focused) window.focusedOrder = ++sequence;
        }),
      ),
    stream: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          const key = `${input.environmentId}\u0000${input.clientId}`;
          const window =
            input.clientId === undefined
              ? undefined
              : {
                  environmentId: input.environmentId,
                  clientId: input.clientId,
                  connectedOrder: ++sequence,
                  focusedOrder: input.focused ? ++sequence : 0,
                };
          yield* Effect.acquireRelease(
            Ref.update(subscribers, (count) => count + 1).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (window) windows.set(key, window);
                }),
              ),
            ),
            () =>
              subscriptionLock.withPermit(
                Ref.update(subscribers, (count) => count - 1).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      // An old stream closing must not unregister its replacement after reconnect.
                      if (windows.get(key) === window) windows.delete(key);
                    }),
                  ),
                ),
              ),
          );
          return Stream.fromSubscription(subscription);
        }).pipe(subscriptionLock.withPermit),
      ),
  });
});

export const layer = Layer.effect(ClientIntents, make);
