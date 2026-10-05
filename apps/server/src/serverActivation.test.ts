import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

import * as ServerActivation from "./serverActivation.ts";

it.effect("proves a root is parked before returning and releases it with one gate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const ran = yield* Deferred.make<void>();

      yield* ServerActivation.forkParked(Deferred.succeed(ran, undefined)).pipe(
        Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
      );
      expect(yield* Deferred.isDone(ran)).toBe(false);

      yield* Deferred.succeed(activation, undefined);
      yield* Deferred.await(ran);
      expect(yield* Deferred.isDone(ran)).toBe(true);
    }),
  ),
);

// Walks the forked fiber's own context object, including Effect's internal base/
// overlay/cacheRoot fields, not just what service lookup resolves. Lookup alone
// can't tell "the ambient span was replaced" apart from "the ambient span is still
// reachable underneath the replacement" -- and the latter is what pins a long-lived
// fiber's memory on a span that should have ended long ago (#5410).
const retainsReference = (root: unknown, target: object): boolean => {
  const seen = new Set<object>();
  const pending: Array<unknown> = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === target) return true;
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    pending.push(...(value instanceof Map ? value.values() : Object.values(value)));
  }
  return false;
};

// Covers both forkParked paths: effects forked immediately, and effects forked behind
// the activation gate. The gated case matters on its own because the parked fiber
// spends time waiting on the activation deferred before it ever reaches `effect`; a
// fix that only detaches `effect` and not the wait would still pin the ambient span
// for however long activation takes.
it.effect.each(["immediate", "gated"] as const)(
  "forkParked does not retain the caller's ambient span in the forked fiber's context (%s)",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const gated = mode === "gated";
        const ambient = Tracer.externalSpan({
          traceId: "00000000000000000000000000000009",
          spanId: "0000000000000009",
          sampled: true,
        });
        const observed = yield* Deferred.make<Context.Context<never>>();
        const observe = Effect.context<never>().pipe(
          Effect.flatMap((context) => Deferred.succeed(observed, context)),
        );

        yield* ServerActivation.forkParked(gated ? Effect.void : observe).pipe(
          Effect.provideService(ServerActivation.ServerActivation, gated ? observe : undefined),
          Effect.provideService(Tracer.ParentSpan, ambient),
        );

        const context = yield* Deferred.await(observed);
        // Lookup resolves a fresh root, not the caller's span.
        expect(Context.getUnsafe(context, Tracer.ParentSpan)).not.toBe(ambient);
        // Nothing in the context's object graph still points back to it either.
        expect(retainsReference(context, ambient)).toBe(false);
      }),
    ),
);
