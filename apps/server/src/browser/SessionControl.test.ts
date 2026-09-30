import { describe, expect, it, vi } from "vite-plus/test";
import {
  BrowserControlInterrupted,
  BrowserFramePacer,
  LatestBrowserFrame,
  SessionControl,
} from "./SessionControl.ts";

it("delivers the trailing static frame and cancels delivery when a viewer closes", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const frames: number[] = [];
    const pacer = new BrowserFramePacer<number>(
      (frame) => frames.push(frame),
      () => 10,
    );
    pacer.offer(1);
    pacer.offer(2);
    pacer.offer(3);
    expect(frames).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(frames).toEqual([1, 3]);
    pacer.offer(4);
    pacer.close();
    vi.advanceTimersByTime(100);
    expect(frames).toEqual([1, 3]);
  } finally {
    vi.useRealTimers();
  }
});

describe("browser control", () => {
  it("waits for a running agent action before takeover and blocks later actions", async () => {
    const control = new SessionControl();
    let finish!: () => void;
    const running = control.agent(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    const queued = control.agent(async () => "unexpected");
    const takeover = control.take("human");
    finish();
    await running;
    await takeover;
    await expect(queued).rejects.toBeInstanceOf(BrowserControlInterrupted);
    await expect(control.human("other", async () => "unexpected")).rejects.toThrow("Take control");
    await control.human("human", async () => "typing");
    await control.release("human");
    await expect(control.agent(async () => "resumed")).resolves.toBe("resumed");
  });

  it("a second watcher cannot steal or release control", async () => {
    const control = new SessionControl();
    await control.take("first");
    await expect(control.take("second")).rejects.toThrow("Another viewer");
    await control.release("second");
    expect(control.controller).toBe("first");
    await control.release("first");
    expect(control.controller).toBeNull();
  });
});

it("drops superseded frames while waiting for a viewer acknowledgement", () => {
  const delivered: number[] = [];
  const frames = new LatestBrowserFrame((frame: { seq: number }) => delivered.push(frame.seq));
  frames.offer({ seq: 1 });
  for (let frame = 2; frame <= 1000; frame++) frames.offer({ seq: frame });
  expect(delivered).toEqual([1]);
  frames.ack(9);
  expect(delivered).toEqual([1]);
  frames.ack(1);
  expect(delivered).toEqual([1, 1000]);
  frames.ack(1);
  frames.offer({ seq: 1001 });
  expect(delivered).toEqual([1, 1000]);
  frames.ack(1000);
  expect(delivered).toEqual([1, 1000, 1001]);
});
