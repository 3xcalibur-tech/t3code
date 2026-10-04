import { assert, describe, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { groupedAfterFirst } from "./streamGrouping.ts";

const WINDOW = Duration.millis(50);

/**
 * Runs `groupedAfterFirst(4, WINDOW)` over a queue-backed source on a test clock
 * that records every sleep, so a test can see each timer the grouping arms.
 */
const withGroupedSource = <A, E>(
  body: (input: {
    readonly source: Queue.Queue<number, Cause.Done>;
    readonly batches: Queue.Queue<ReadonlyArray<number>>;
    readonly sleeps: Queue.Queue<Duration.Duration>;
    readonly fiber: Fiber.Fiber<void>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith(Effect.succeed);
    const sleeps = yield* Queue.unbounded<Duration.Duration>();
    const clock: TestClock.TestClock = {
      ...testClock,
      sleep: (duration) =>
        Queue.offer(sleeps, duration).pipe(Effect.andThen(testClock.sleep(duration))),
    };
    return yield* Effect.gen(function* () {
      const source = yield* Queue.unbounded<number, Cause.Done>();
      const batches = yield* Queue.unbounded<ReadonlyArray<number>>();
      const fiber = yield* Stream.fromQueue(source).pipe(
        groupedAfterFirst(4, WINDOW),
        Stream.runForEach((batch) => Queue.offer(batches, batch)),
        Effect.forkScoped,
      );
      return yield* body({ source, batches, sleeps, fiber });
    }).pipe(Effect.provideService(Clock.Clock, clock));
  }).pipe(Effect.scoped);

describe("groupedAfterFirst", () => {
  it.effect("arms no timer while the source is idle", () =>
    withGroupedSource(({ source, batches, sleeps }) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(Duration.seconds(10));
        assert.equal(yield* Queue.size(sleeps), 0);

        yield* Queue.offer(source, 1);
        assert.deepEqual(yield* Queue.take(sleeps), WINDOW);
        yield* TestClock.adjust(WINDOW);
        assert.deepEqual(yield* Queue.take(batches), [1]);

        yield* TestClock.adjust(Duration.seconds(10));
        assert.equal(yield* Queue.size(sleeps), 0);
      }),
    ),
  );

  it.effect("batches a burst the way groupedWithin does", () =>
    withGroupedSource(({ source, batches, sleeps }) =>
      Effect.gen(function* () {
        // A partial group waits out the window opened by its first item.
        yield* Queue.offerAll(source, [1, 2, 3]);
        yield* Queue.take(sleeps);
        assert.equal(yield* Queue.size(batches), 0);
        yield* TestClock.adjust(WINDOW);
        assert.deepEqual(yield* Queue.take(batches), [1, 2, 3]);

        // A full group goes out at once; the rest opens the next window.
        yield* Queue.offerAll(source, [4, 5, 6, 7, 8, 9]);
        assert.deepEqual(yield* Queue.take(batches), [4, 5, 6, 7]);
        yield* Queue.take(sleeps);
        yield* TestClock.adjust(WINDOW);
        assert.deepEqual(yield* Queue.take(batches), [8, 9]);

        // A group that fills during its window goes out without waiting it out.
        yield* Queue.offer(source, 10);
        yield* Queue.take(sleeps);
        yield* Queue.offerAll(source, [11, 12, 13, 14]);
        assert.deepEqual(yield* Queue.take(batches), [10, 11, 12, 13]);
        yield* Queue.take(sleeps);
        yield* TestClock.adjust(WINDOW);
        assert.deepEqual(yield* Queue.take(batches), [14]);
        assert.equal(yield* Queue.size(sleeps), 0);
      }),
    ),
  );

  it.effect("delivers the last group when the source ends", () =>
    withGroupedSource(({ source, batches, fiber }) =>
      Effect.gen(function* () {
        yield* Queue.offer(source, 1);
        yield* Queue.end(source);
        // The group goes out once the end reaches the window, or when the window
        // elapses, whichever comes first.
        yield* TestClock.adjust(WINDOW);
        assert.deepEqual(yield* Queue.take(batches), [1]);
        yield* Fiber.join(fiber);
      }),
    ),
  );
});
