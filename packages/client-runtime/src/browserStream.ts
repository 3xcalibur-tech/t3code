import {
  PreviewBrowserServerMessage,
  type PreviewBrowserClientMessage,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { withDeviceHubQuery, type DeviceHubAccess } from "./state/deviceHubAccess.ts";

export type BrowserFrame = Extract<PreviewBrowserServerMessage, { readonly type: "frame" }>;
export type BrowserControl = Extract<PreviewBrowserServerMessage, { readonly type: "control" }>;
export type BrowserStreamStatus = "connecting" | "connected" | "reconnecting";

const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(PreviewBrowserServerMessage),
);

export function browserStreamUrl(
  access: DeviceHubAccess,
  threadRef: ScopedThreadRef,
  tabId: string,
): string {
  return withDeviceHubQuery(
    `${access.wsBase}/${encodeURIComponent(threadRef.threadId)}/${encodeURIComponent(tabId)}/ws`,
    access,
  );
}

/** Letterboxed viewers preserve browser coordinates and ignore clicks outside the page. */
export function browserPoint(input: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly deviceWidth: number;
  readonly deviceHeight: number;
}): { readonly x: number; readonly y: number } | null {
  if (input.width <= 0 || input.height <= 0 || input.deviceWidth <= 0 || input.deviceHeight <= 0)
    return null;
  const scale = Math.min(input.width / input.deviceWidth, input.height / input.deviceHeight);
  const x = (input.x - (input.width - input.deviceWidth * scale) / 2) / scale;
  const y = (input.y - (input.height - input.deviceHeight * scale) / 2) / scale;
  return x >= 0 && y >= 0 && x < input.deviceWidth && y < input.deviceHeight ? { x, y } : null;
}

export function browserModifiers(input: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number {
  return (
    (input.altKey ? 1 : 0) |
    (input.ctrlKey ? 2 : 0) |
    (input.metaKey ? 4 : 0) |
    (input.shiftKey ? 8 : 0)
  );
}

export type BrowserStreamSocket = Pick<
  WebSocket,
  "readyState" | "onopen" | "onclose" | "onerror" | "onmessage" | "send" | "close"
>;

/** Media stays on this disposable connection; reconnect always obtains fresh environment access. */
export function createBrowserStream(input: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly access: () => Promise<DeviceHubAccess>;
  readonly socket: (url: string) => BrowserStreamSocket;
  readonly onMessage: (message: PreviewBrowserServerMessage) => void;
  readonly onStatus: (status: BrowserStreamStatus) => void;
  readonly onError: (message: string) => void;
}) {
  let disposed = false;
  let connection: BrowserStreamSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;

  const reconnect = () => {
    if (disposed || reconnectTimer !== null) return;
    input.onStatus("reconnecting");
    // @effect-diagnostics-next-line globalTimers:off -- This disposable client transport uses the platform timer; close cancels it.
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = null;
        void connect();
      },
      Math.min(8_000, 500 * 2 ** Math.min(retries++, 4)),
    );
  };

  const connect = async () => {
    try {
      const access = await input.access();
      if (disposed) return;
      const socket = input.socket(browserStreamUrl(access, input.threadRef, input.tabId));
      connection = socket;
      socket.onopen = () => {
        if (disposed || connection !== socket) return;
        retries = 0;
        input.onStatus("connected");
        socket.send(
          JSON.stringify({
            type: "config",
            maxFps: 15,
            pacing: "ack",
          } satisfies PreviewBrowserClientMessage),
        );
      };
      socket.onmessage = (event) => {
        if (disposed || connection !== socket || typeof event.data !== "string") return;
        const decoded = decodeMessage(event.data);
        if (Option.isSome(decoded)) input.onMessage(decoded.value);
      };
      socket.onclose = () => {
        if (connection !== socket) return;
        connection = null;
        reconnect();
      };
      socket.onerror = () => {
        if (disposed || connection !== socket) return;
        input.onError("The browser stream disconnected.");
        socket.close();
      };
    } catch {
      if (disposed) return;
      input.onError("Unable to connect to the environment's browser.");
      reconnect();
    }
  };

  input.onStatus("connecting");
  void connect();

  return {
    send(message: PreviewBrowserClientMessage): boolean {
      if (disposed || connection?.readyState !== 1) return false;
      connection.send(JSON.stringify(message));
      return true;
    },
    close() {
      disposed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      connection?.close();
      connection = null;
    },
  };
}
