import type { PreviewBrowserClientMessage } from "@t3tools/contracts";
import type { BrowserControl } from "@t3tools/client-runtime/browser-stream";

/** User input waits for takeover confirmation, then yields after interaction stops. */
export function createBrowserInteraction(input: {
  send: (message: PreviewBrowserClientMessage) => boolean;
  active: () => boolean;
  error: (message: string) => void;
}) {
  let control: BrowserControl | null = null;
  let pending = false;
  let held = false;
  let queued: PreviewBrowserClientMessage[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const owns = () => control !== null && control.controller === control.viewerId;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const yieldWhenIdle = () => {
    clearTimer();
    if (held || input.active()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (owns() && !held && !input.active()) input.send({ type: "release_control" });
    }, 1500);
  };
  const take = () => {
    if (pending) return true;
    pending = input.send({ type: "take_control" });
    return pending;
  };
  return {
    send(message: PreviewBrowserClientMessage) {
      if (control === null) return false;
      if (control.controller !== null && !owns()) {
        input.error("Another viewer controls this browser.");
        return false;
      }
      clearTimer();
      if (owns()) {
        const sent = input.send(message);
        yieldWhenIdle();
        return sent;
      }
      if (queued.length >= 256) {
        input.error("Browser input is waiting for control. Try again.");
        return false;
      }
      queued.push(message);
      if (!take()) {
        queued = [];
        return false;
      }
      return true;
    },
    control(next: BrowserControl) {
      control = next;
      if (owns()) {
        pending = false;
        const messages = queued;
        queued = [];
        for (const message of messages) input.send(message);
        yieldWhenIdle();
      } else if (next.controller !== null) {
        pending = false;
        queued = [];
        clearTimer();
      }
    },
    hold(next: boolean) {
      held = next;
      if (held) {
        clearTimer();
        if (!owns()) take();
      } else yieldWhenIdle();
    },
    idle: yieldWhenIdle,
    failed() {
      pending = false;
      queued = [];
    },
    close() {
      clearTimer();
      queued = [];
      pending = false;
      held = false;
      control = null;
    },
  };
}
