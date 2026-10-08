import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { threadFindIndex, threadFindPosition } from "./threadFind.logic";

const older = MessageId.make("older");
const newer = MessageId.make("newer");
const matches = [
  { messageId: older, count: 2 },
  { messageId: newer, count: 3 },
];

describe("thread find positions", () => {
  it("starts at the newest occurrence", () => {
    expect(threadFindIndex(matches, null)).toEqual({ index: 4, total: 5 });
  });

  it("keeps its message when results refresh, and clamps a shrunken count", () => {
    expect(threadFindIndex(matches, { messageId: newer, occurrence: 1 }).index).toBe(3);
    expect(threadFindIndex(matches, { messageId: older, occurrence: 5 }).index).toBe(1);
    expect(
      threadFindIndex(matches, { messageId: MessageId.make("gone"), occurrence: 0 }).index,
    ).toBe(4);
  });

  it("maps an index back to its message and occurrence", () => {
    expect(threadFindPosition(matches, 2)).toEqual({ messageId: newer, occurrence: 0 });
    expect(threadFindPosition(matches, 5)).toBeNull();
  });
});
