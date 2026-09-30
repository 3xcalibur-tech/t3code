import { afterEach, expect, it, vi } from "vite-plus/test";
import { createBrowserInteraction } from "./browserInteraction";
import type { PreviewBrowserClientMessage } from "@t3tools/contracts";

afterEach(() => vi.useRealTimers());

it("waits for takeover before forwarding the first click and yields after input stops", () => {
  vi.useFakeTimers();
  const messages: PreviewBrowserClientMessage[] = [];
  let active = true;
  const interaction = createBrowserInteraction({
    send: (message) => {
      messages.push(message);
      return true;
    },
    active: () => active,
    error: () => undefined,
  });
  interaction.control({ type: "control", viewerId: "me", controller: null });
  interaction.send({ type: "input_mouse", eventType: "mousePressed", x: 10, y: 20 });
  expect(messages.map((message) => message.type)).toEqual(["take_control"]);
  interaction.control({ type: "control", viewerId: "me", controller: "me" });
  expect(messages.map((message) => message.type)).toEqual(["take_control", "input_mouse"]);
  vi.advanceTimersByTime(5000);
  expect(messages.at(-1)?.type).toBe("input_mouse");
  active = false;
  interaction.idle();
  vi.advanceTimersByTime(1500);
  expect(messages.at(-1)?.type).toBe("release_control");
  interaction.close();
});

it("keeps control for a paused agent and discards queued input when another viewer owns it", () => {
  vi.useFakeTimers();
  const send = vi.fn(() => true);
  const error = vi.fn();
  const interaction = createBrowserInteraction({ send, active: () => false, error });
  interaction.control({ type: "control", viewerId: "me", controller: null });
  interaction.hold(true);
  interaction.control({ type: "control", viewerId: "me", controller: "me" });
  vi.advanceTimersByTime(5000);
  expect(send).toHaveBeenCalledTimes(1);
  interaction.control({ type: "control", viewerId: "me", controller: "other" });
  expect(interaction.send({ type: "navigate", url: "https://example.test" })).toBe(false);
  expect(error).toHaveBeenCalledWith("Another viewer controls this browser.");
  interaction.close();
});

it("lets the next input retry after takeover fails without replaying the failed input", () => {
  const messages: PreviewBrowserClientMessage[] = [];
  const interaction = createBrowserInteraction({
    send: (message) => {
      messages.push(message);
      return true;
    },
    active: () => false,
    error: () => undefined,
  });
  interaction.control({ type: "control", viewerId: "me", controller: null });
  interaction.send({ type: "navigate", url: "https://failed.test" });
  interaction.failed();
  interaction.send({ type: "navigate", url: "https://retry.test" });
  interaction.control({ type: "control", viewerId: "me", controller: "me" });
  expect(messages).toEqual([
    { type: "take_control" },
    { type: "take_control" },
    { type: "navigate", url: "https://retry.test" },
  ]);
  interaction.close();
});
