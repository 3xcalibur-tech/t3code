import { EnvironmentId, ThreadId, type PreviewBrowserServerMessage } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  browserModifiers,
  browserPoint,
  browserStreamUrl,
  createBrowserStream,
  type BrowserStreamSocket,
} from "./browserStream.ts";
import type { DeviceHubAccess } from "./state/deviceHubAccess.ts";

const threadRef = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread with spaces"),
};
const access: DeviceHubAccess = {
  httpBase: "https://env.example/api/browser",
  wsBase: "wss://env.example/api/browser",
  credentials: false,
  query: { wsTicket: "first-ticket" },
};

class TestSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { readonly data: string }) => void) | null = null;
  readonly send = vi.fn<(message: string) => void>();
  readonly close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

afterEach(() => vi.useRealTimers());

describe("environment browser transport", () => {
  it("keeps stream access on the environment origin and encodes thread and tab IDs", () => {
    expect(browserStreamUrl(access, threadRef, "tab / one")).toBe(
      "wss://env.example/api/browser/thread%20with%20spaces/tab%20%2F%20one/ws?wsTicket=first-ticket",
    );
  });

  it("decodes frames, requests ack pacing, and drops data after the viewer closes", async () => {
    const receipt = Promise.withResolvers<TestSocket>();
    const onMessage = vi.fn<(message: PreviewBrowserServerMessage) => void>();
    const stream = createBrowserStream({
      threadRef,
      tabId: "tab",
      access: async () => access,
      socket: () => {
        const socket = new TestSocket();
        receipt.resolve(socket);
        return socket as BrowserStreamSocket;
      },
      onMessage,
      onStatus: vi.fn(),
      onError: vi.fn(),
    });
    const socket = await receipt.promise;
    socket.open();
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "config", maxFps: 15, pacing: "ack" }),
    );
    const frame = {
      type: "frame",
      seq: 7,
      data: "JPEG",
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    } as const;
    socket.message(frame);
    socket.message({ type: "frame", data: "missing-seq" });
    socket.message({ type: "unknown" });
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(frame);
    expect(stream.send({ type: "ack", seq: 7 })).toBe(true);
    stream.close();
    socket.message(frame);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(stream.send({ type: "take_control" })).toBe(false);
  });

  it("obtains new tickets on reconnect and never reconnects a disposed viewer", async () => {
    vi.useFakeTimers();
    const receipt = Promise.withResolvers<TestSocket>();
    const sockets: TestSocket[] = [];
    const urls: string[] = [];
    const getAccess = vi
      .fn()
      .mockResolvedValueOnce(access)
      .mockResolvedValue({ ...access, query: { wsTicket: "fresh-ticket" } });
    const stream = createBrowserStream({
      threadRef,
      tabId: "tab",
      access: getAccess,
      socket: (url) => {
        const socket = new TestSocket();
        sockets.push(socket);
        urls.push(url);
        receipt.resolve(socket);
        return socket as BrowserStreamSocket;
      },
      onMessage: vi.fn(),
      onStatus: vi.fn(),
      onError: vi.fn(),
    });
    const initial = await receipt.promise;
    initial.open();
    initial.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(getAccess).toHaveBeenCalledTimes(2);
    expect(urls[1]).toContain("wsTicket=fresh-ticket");
    stream.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(2);
  });
});

describe("browser input coordinates", () => {
  it("maps a downscaled page back to CSS viewport coordinates and ignores letterboxing", () => {
    const viewport = { width: 400, height: 400, deviceWidth: 1600, deviceHeight: 800 };
    expect(browserPoint({ ...viewport, x: 200, y: 200 })).toEqual({ x: 800, y: 400 });
    expect(browserPoint({ ...viewport, x: 200, y: 50 })).toBeNull();
    expect(browserPoint({ ...viewport, x: 399, y: 299 })).toEqual({ x: 1596, y: 796 });
    expect(browserPoint({ ...viewport, width: 0, x: 0, y: 0 })).toBeNull();
  });

  it("preserves CDP keyboard modifiers", () => {
    expect(browserModifiers({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: true })).toBe(
      13,
    );
    expect(
      browserModifiers({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: false }),
    ).toBe(2);
  });
});
