import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDesktopBrowserStream } from "./BrowserStream.ts";

type Message = { type: string; seq?: number; viewerId?: string; controller?: string | null };
async function connect(url: string) {
  const client = new WebSocket(url);
  const messages: Message[] = [];
  const waiters: Array<{ type: string; resolve: (message: Message) => void }> = [];
  client.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Message;
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(message);
    else messages.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  return {
    client,
    next(type: string) {
      const index = messages.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]!);
      return new Promise<Message>((resolve) => waiters.push({ type, resolve }));
    },
  };
}
const image = {
  data: "jpeg",
  width: 1280,
  height: 720,
  url: "http://preview/",
  canGoBack: false,
  canGoForward: false,
};
afterEach(() => {
  vi.useRealTimers();
});

describe("native browser stream lifecycle", () => {
  it("captures only when a viewer can accept a frame and ignores duplicate acknowledgements", async () => {
    vi.useFakeTimers();
    const released = Promise.withResolvers<void>();
    const capture = vi.fn(async () => image);
    const stream = await createDesktopBrowserStream({
      capture,
      takeControl: async () => {},
      releaseControl: async () => {
        released.resolve();
      },
      command: async () => {},
    });
    expect(capture).not.toHaveBeenCalled();
    const viewer = await connect(stream.url);
    try {
      await viewer.next("control");
      viewer.client.send(JSON.stringify({ type: "config", pacing: "ack" }));
      viewer.client.send(JSON.stringify({ type: "take_control" }));
      await viewer.next("control");
      await vi.advanceTimersByTimeAsync(1);
      const first = await viewer.next("frame");
      expect(capture).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(capture).toHaveBeenCalledTimes(1);
      viewer.client.send(JSON.stringify({ type: "ack", seq: first.seq }));
      viewer.client.send(JSON.stringify({ type: "take_control" }));
      await viewer.next("control");
      await vi.advanceTimersByTimeAsync(1000);
      const second = await viewer.next("frame");
      expect(second.seq).not.toBe(first.seq);
      expect(capture).toHaveBeenCalledTimes(2);
      viewer.client.send(JSON.stringify({ type: "ack", seq: first.seq }));
      viewer.client.send(JSON.stringify({ type: "take_control" }));
      await viewer.next("control");
      await vi.advanceTimersByTimeAsync(1000);
      expect(capture).toHaveBeenCalledTimes(2);
      viewer.client.close();
      await released.promise;
      await vi.advanceTimersByTimeAsync(1000);
      expect(capture).toHaveBeenCalledTimes(2);
    } finally {
      viewer.client.terminate();
      await stream.close();
    }
  });

  it("releases a takeover that completes after its viewer disconnects", async () => {
    const taking = Promise.withResolvers<void>();
    const finishTake = Promise.withResolvers<void>();
    const released = Promise.withResolvers<string>();
    const release = vi.fn(async (viewer: string) => {
      released.resolve(viewer);
    });
    const stream = await createDesktopBrowserStream({
      capture: async () => image,
      takeControl: async () => {
        taking.resolve();
        await finishTake.promise;
      },
      releaseControl: release,
      command: async () => {},
    });
    const viewer = await connect(stream.url);
    try {
      const initial = await viewer.next("control");
      viewer.client.send(JSON.stringify({ type: "take_control" }));
      await taking.promise;
      const closed = new Promise<void>((resolve) => viewer.client.once("close", () => resolve()));
      viewer.client.close();
      await closed;
      finishTake.resolve();
      expect(await released.promise).toBe(initial.viewerId);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      finishTake.resolve();
      viewer.client.terminate();
      await stream.close();
    }
  });

  it("acknowledges viewport changes only after the controlling viewer applies them", async () => {
    const applied = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const command = vi.fn(async () => {
      started.resolve();
      await applied.promise;
    });
    const stream = await createDesktopBrowserStream({
      capture: async () => image,
      takeControl: async () => {},
      releaseControl: async () => {},
      command,
    });
    const viewer = await connect(stream.url);
    const viewport = { _tag: "freeform", width: 800, height: 600 };
    try {
      await viewer.next("control");
      viewer.client.send(JSON.stringify({ type: "set_viewport", viewport }));
      await viewer.next("error");
      expect(command).not.toHaveBeenCalled();
      viewer.client.send(JSON.stringify({ type: "take_control" }));
      await viewer.next("control");
      viewer.client.send(JSON.stringify({ type: "set_viewport", viewport }));
      await started.promise;
      applied.resolve();
      expect(await viewer.next("viewport")).toMatchObject({ type: "viewport", viewport });
    } finally {
      applied.resolve();
      viewer.client.terminate();
      await stream.close();
    }
  });

  it("announces explicit native takeover to remote observers", async () => {
    const stream = await createDesktopBrowserStream({
      capture: async () => image,
      takeControl: async () => {},
      releaseControl: async () => {},
      command: async () => {},
    });
    const viewer = await connect(stream.url);
    try {
      await viewer.next("control");
      stream.evictController("native");
      expect((await viewer.next("control")).controller).toBe("native");
      stream.evictController();
      expect((await viewer.next("control")).controller).toBeNull();
    } finally {
      viewer.client.terminate();
      await stream.close();
    }
  });
});
