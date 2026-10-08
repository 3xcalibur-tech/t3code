import type { MessageId, OrchestrationFindInThreadResult } from "@t3tools/contracts";

type FindMatches = OrchestrationFindInThreadResult["matches"];

export interface ThreadFindPosition {
  readonly messageId: MessageId;
  readonly occurrence: number;
}

/**
 * The index of `position` among all occurrences, oldest first. A missing
 * position, or one whose message no longer matches, falls back to the newest
 * occurrence, where the user usually is.
 */
export function threadFindIndex(
  matches: FindMatches,
  position: ThreadFindPosition | null,
): { readonly index: number; readonly total: number } {
  let total = 0;
  let index: number | null = null;
  for (const match of matches) {
    if (index === null && match.messageId === position?.messageId) {
      index = total + Math.min(position.occurrence, match.count - 1);
    }
    total += match.count;
  }
  return { index: index ?? total - 1, total };
}

/** The message and occurrence at `index`, or null when out of range. */
export function threadFindPosition(matches: FindMatches, index: number): ThreadFindPosition | null {
  let remaining = index;
  for (const match of matches) {
    if (remaining < match.count) return { messageId: match.messageId, occurrence: remaining };
    remaining -= match.count;
  }
  return null;
}
