// @effect-diagnostics globalDate:off globalTimers:off -- WebSocket demand capture and pacing run at native callback boundaries.
import * as NodeCrypto from "node:crypto";
import { PreviewBrowserClientMessage } from "@t3tools/contracts";
import { Schema } from "effect";
import { WebSocket, WebSocketServer } from "ws";

const decode = Schema.decodeUnknownSync(PreviewBrowserClientMessage);

/** Captures only while observed; a slow viewer holds at most one pending JPEG. */
export async function createDesktopBrowserStream(input: {
  capture: () => Promise<{
    data: string;
    width: number;
    height: number;
    url: string;
    canGoBack: boolean;
    canGoForward: boolean;
  }>;
  takeControl: (viewer: string) => Promise<void>;
  releaseControl: (viewer: string) => Promise<void>;
  command: (viewer: string, message: PreviewBrowserClientMessage) => Promise<void>;
}) {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: `/${NodeCrypto.randomUUID()}`,
    maxPayload: 100_000,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start the native browser stream.");
  const clients = new Map<
    WebSocket,
    { viewer: string; fps: number; ack: boolean; pending: number | undefined; sentAt: number }
  >();
  let controller: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let captureInFlight = false;
  let lastAttemptAt = 0;
  let controlGeneration = 0;
  let sequence = 0;
  const send = (client: WebSocket, message: object) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };
  const broadcastControl = () => {
    for (const [client, state] of clients)
      send(client, { type: "control", viewerId: state.viewer, controller });
  };
  const scheduleCapture = () => {
    if (closed || captureInFlight || timer) return;
    const ready = [...clients].filter(
      ([client, state]) => client.readyState === WebSocket.OPEN && state.pending === undefined,
    );
    if (ready.length === 0) return;
    const now = Date.now();
    const nextAt = Math.min(...ready.map(([, state]) => state.sentAt + 1000 / state.fps));
    timer = setTimeout(
      () => {
        void capture();
      },
      Math.ceil(Math.max(1, nextAt - now, lastAttemptAt + 1000 / 12 - now)),
    );
  };
  const capture = async () => {
    timer = undefined;
    if (closed || clients.size === 0) return;
    const ready = [...clients].some(
      ([client, state]) =>
        client.readyState === WebSocket.OPEN &&
        client.bufferedAmount <= 256_000 &&
        state.pending === undefined &&
        Date.now() - state.sentAt >= 1000 / state.fps,
    );
    if (!ready) {
      lastAttemptAt = Date.now();
      scheduleCapture();
      return;
    }
    captureInFlight = true;
    lastAttemptAt = Date.now();
    try {
      const frame = await input.capture();
      const now = Date.now();
      const seq = ++sequence;
      for (const [client, state] of clients) {
        if (
          client.bufferedAmount > 256_000 ||
          state.pending !== undefined ||
          now - state.sentAt < 1000 / state.fps
        )
          continue;
        state.sentAt = now;
        if (state.ack) state.pending = seq;
        send(client, {
          type: "frame",
          seq,
          data: frame.data,
          metadata: { deviceWidth: frame.width, deviceHeight: frame.height, timestamp: now / 1000 },
        });
        send(client, { type: "url", url: frame.url });
        send(client, {
          type: "status",
          connected: true,
          screencasting: true,
          viewportWidth: frame.width,
          viewportHeight: frame.height,
          canGoBack: frame.canGoBack,
          canGoForward: frame.canGoForward,
        });
      }
    } catch {
      /* Guests briefly reject captures while their renderer changes. */
    }
    captureInFlight = false;
    scheduleCapture();
  };
  server.on("connection", (client) => {
    const state = {
      viewer: NodeCrypto.randomUUID(),
      fps: 12,
      ack: false,
      pending: undefined as number | undefined,
      sentAt: 0,
    };
    clients.set(client, state);
    send(client, { type: "control", viewerId: state.viewer, controller });
    scheduleCapture();
    let queue = Promise.resolve();
    client.on("message", (bytes) => {
      let message: PreviewBrowserClientMessage;
      try {
        message = decode(JSON.parse(bytes.toString()));
      } catch {
        send(client, { type: "error", message: "Invalid browser message." });
        return;
      }
      if (message.type === "config") {
        if (message.maxFps !== undefined)
          state.fps = message.maxFps === 0 ? 12 : Math.max(1, Math.min(12, message.maxFps));
        if (message.pacing !== undefined) {
          state.ack = message.pacing === "ack";
          state.pending = undefined;
        }
        scheduleCapture();
        return;
      }
      if (message.type === "ack") {
        if (state.pending === message.seq) {
          state.pending = undefined;
          scheduleCapture();
        }
        return;
      }
      queue = queue
        .then(async () => {
          if (!clients.has(client)) return;
          if (message.type === "take_control") {
            const generation = controlGeneration;
            await input.takeControl(state.viewer);
            if (
              !clients.has(client) ||
              client.readyState !== WebSocket.OPEN ||
              generation !== controlGeneration
            ) {
              await input.releaseControl(state.viewer);
              return;
            }
            controlGeneration++;
            controller = state.viewer;
            broadcastControl();
          } else if (message.type === "release_control") {
            if (controller !== state.viewer) return;
            await input.releaseControl(state.viewer);
            if (controller === state.viewer) {
              controller = null;
              controlGeneration++;
            }
            broadcastControl();
          } else {
            if (controller !== state.viewer)
              throw new Error("Take browser control before interacting.");
            await input.command(state.viewer, message);
          }
        })
        .catch((error) =>
          send(client, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
    });
    client.on("error", () => {});
    client.once("close", () => {
      clients.delete(client);
      if (controller === state.viewer) {
        controller = null;
        controlGeneration++;
        void input
          .releaseControl(state.viewer)
          .catch(() => {})
          .finally(broadcastControl);
      }
      if (clients.size === 0 && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${address.port}${server.options.path}`,
    evictController(owner: string | null = null) {
      controller = owner;
      controlGeneration++;
      broadcastControl();
    },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (controller) await input.releaseControl(controller).catch(() => {});
      controller = null;
      for (const client of clients.keys()) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type DesktopBrowserStream = Awaited<ReturnType<typeof createDesktopBrowserStream>>;
