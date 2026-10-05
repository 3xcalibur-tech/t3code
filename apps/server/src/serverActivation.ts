import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import * as NodeCrypto from "node:crypto";

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "t3/serverActivation",
  { defaultValue: () => undefined },
) {}

// A forked child fiber gets the exact same Context object its caller holds at fork
// time, base/overlay chain and all. These reactors run for the life of the process,
// so whatever span was ambient when they started (e.g. a startup span) stays reachable
// through that chain forever, which is the retained-span growth in #5410. Flattening
// into a fresh Map and swapping in a stateless external span breaks that chain: the
// forked fiber's own context then holds no reference back to the caller's span.
// Applying this to `Effect.forkScoped(effect)` itself (not to `effect`) matters: it
// swaps the *forking* fiber's context for the instant of the fork, so the new child
// is born with the detached context directly, and the closure that restores the
// caller's original context runs right after the (synchronous, quick) fork returns,
// not after `effect` itself completes. Wrapping `effect` instead would pin the old
// context in that restore closure for as long as `effect` runs, i.e. forever.
export const forkScopedDetached = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Fiber.Fiber<A, E>, never, Scope.Scope | Exclude<R, Tracer.ParentSpan>> =>
  Effect.updateContext(
    Effect.forkScoped(effect),
    (context: Context.Context<Scope.Scope | Exclude<R, Tracer.ParentSpan>>) => {
      const traceId = NodeCrypto.randomUUID().replaceAll("-", "");
      const root = Tracer.externalSpan({ traceId, spanId: traceId.slice(0, 16), sampled: true });
      // Context.merge already flattens (it copies the full map, not an overlay) and
      // overrides on top, which is exactly "detach"; prefer it over hand-rolling the
      // same flatten with Context.add + makeUnsafe (see Context.ts's own guidance).
      return Context.merge(context, Context.make(Tracer.ParentSpan, root)) as Context.Context<
        Scope.Scope | R
      >;
    },
  );

/** Forks a long-running root before commit, returning it after it reaches the activation boundary. */
export const forkParkedFiber = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Fiber.Fiber<A, E>, never, Scope.Scope | Exclude<R, Tracer.ParentSpan>> =>
  Effect.gen(function* () {
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      return yield* forkScopedDetached(effect);
    }
    const parked = yield* Deferred.make<void>();
    const fiber = yield* forkScopedDetached(
      Deferred.succeed(parked, undefined).pipe(Effect.andThen(activation), Effect.andThen(effect)),
    );
    yield* Deferred.await(parked);
    return fiber;
  });

/** Forks a long-running root before commit and proves it is parked at the activation boundary. */
export const forkParked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | Exclude<R, Tracer.ParentSpan>> =>
  forkParkedFiber(effect).pipe(Effect.asVoid);
