import { expect, it } from "vite-plus/test";
import { BrowserLifecycle } from "./BrowserLifecycle.ts";

it("closing a thread cancels its unfinished opens while another thread can finish on the profile", () => {
  const lifecycle = new BrowserLifecycle();
  const closed = lifecycle.start("thread-1", "tab-1", "profile");
  const kept = lifecycle.start("thread-2", "tab-2", "profile");
  lifecycle.cancel("thread-1");
  expect(closed.controller.signal.aborted).toBe(true);
  expect(kept.controller.signal.aborted).toBe(false);
  expect(lifecycle.hasPendingProfile("profile")).toBe(true);
  lifecycle.finish(closed);
  lifecycle.finish(kept);
  expect(lifecycle.hasPendingProfile("profile")).toBe(false);
});

it("finishing a superseded open cannot remove its replacement", () => {
  const lifecycle = new BrowserLifecycle();
  const first = lifecycle.start("thread", "tab", "profile");
  const second = lifecycle.start("thread", "tab", "profile");
  expect(first.controller.signal.aborted).toBe(true);
  lifecycle.finish(first);
  expect(lifecycle.hasPendingProfile("profile")).toBe(true);
  lifecycle.cancel();
  expect(second.controller.signal.aborted).toBe(true);
});
