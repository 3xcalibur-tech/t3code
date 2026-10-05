import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/**
 * Groups a stream into arrays of up to `maxSize` items, like `Stream.groupedWithin`,
 * except that a group's window opens when its first item arrives. A group is
 * emitted once it is full, when the window elapses, or when the source ends.
 *
 * `groupedWithin` keeps its schedule ticking while the source is idle, which wakes
 * the server for every open subscription. Here an idle source arms no timer.
 *
 * The hand-off queue holds at most `maxSize` items, so a budgeted source still
 * sees backpressure when the consumer falls behind, one group later than with
 * `groupedWithin`.
 */
export const groupedAfterFirst =
  (maxSize: number, window: Duration.Input) =>
  <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<Array<A>, E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Stream.toQueue(self, { capacity: maxSize });
        return Stream.fromEffectRepeat(
          Effect.gen(function* () {
            const group = yield* Queue.takeBetween(queue, 1, maxSize);
            if (group.length < maxSize) {
              // A failed fill means the source ended, failed or died. The group
              // goes out now and the next take reports the end.
              yield* fillGroup(queue, group, maxSize).pipe(
                Effect.timeoutOption(window),
                Effect.ignoreCause,
              );
            }
            return group;
          }),
        );
      }),
    );

// The window can interrupt the fill only while it waits. `peek` takes nothing, and
// a take with its push cannot be interrupted, so no item is dropped between them.
const fillGroup = <A, E>(queue: Queue.Dequeue<A, E>, group: Array<A>, maxSize: number) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.whileLoop({
      while: () => group.length < maxSize,
      body: () =>
        restore(Queue.peek(queue)).pipe(
          Effect.andThen(Queue.takeBetween(queue, 1, maxSize - group.length)),
        ),
      step: (items) => {
        group.push(...items);
      },
    }),
  );
