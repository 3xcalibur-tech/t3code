"use client";

import {
  browserModifiers,
  browserPoint,
  createBrowserStream,
  type BrowserControl,
  type BrowserFrame,
  type BrowserStreamStatus,
} from "@t3tools/client-runtime/browser-stream";
import { resolveDeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type {
  PreviewBrowserClientMessage,
  PreviewViewportSetting,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
  type PointerEvent,
  type KeyboardEvent,
} from "react";

import { createBrowserInteraction } from "~/browser/browserInteraction";
import { runtime } from "~/lib/runtime";
import { readPreparedConnection, usePreparedConnection } from "~/state/session";

export interface ServerBrowserViewHandle {
  readonly send: (message: PreviewBrowserClientMessage) => boolean;
  readonly setHoldControl: (held: boolean) => void;
}

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly visible: boolean;
  readonly ref?: Ref<ServerBrowserViewHandle>;
  readonly compact?: boolean;
  readonly viewport?: PreviewViewportSetting;
  readonly onHoldControlChange?: (held: boolean) => void;
}

/** Shows the environment's browser and coordinates agent access around user input. */
export function ServerBrowserView({
  threadRef,
  tabId,
  visible,
  ref,
  viewport,
  onHoldControlChange,
}: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<BrowserFrame | null>(null);
  const streamRef = useRef<ReturnType<typeof createBrowserStream> | null>(null);
  const interactionRef = useRef<ReturnType<typeof createBrowserInteraction> | null>(null);
  const heldKeys = useRef(new Set<string>());
  const [status, setStatus] = useState<BrowserStreamStatus>("connecting");
  const [control, setControl] = useState<BrowserControl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [foreground, setForeground] = useState(() => document.visibilityState !== "hidden");
  const pressedRef = useRef<{ x: number; y: number; button: "left" | "middle" | "right" } | null>(
    null,
  );
  const touchesRef = useRef(new Map<number, { x: number; y: number; id: number }>());
  const prepared = usePreparedConnection(threadRef.environmentId);
  const controlling =
    status === "connected" && control !== null && control.viewerId === control.controller;

  useEffect(() => {
    const changed = () => setForeground(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);

  const interactive =
    status === "connected" && control !== null && (control.controller === null || controlling);
  const sendInput = (message: PreviewBrowserClientMessage) =>
    interactionRef.current?.send(message) ?? false;
  useImperativeHandle(ref, () => ({
    send: sendInput,
    setHoldControl: (held) => {
      interactionRef.current?.hold(held);
      onHoldControlChange?.(held);
    },
  }));

  const onMessage = useEffectEvent(
    (message: Parameters<Parameters<typeof createBrowserStream>[0]["onMessage"]>[0]) => {
      if (message.type === "frame") {
        frameRef.current = message;
        if (imageRef.current) imageRef.current.src = `data:image/jpeg;base64,${message.data}`;
      } else if (message.type === "control") {
        interactionRef.current?.control(message);
        setControl(message);
        setError(null);
      } else if (message.type === "error") {
        interactionRef.current?.failed();
        setError(message.message);
      }
    },
  );

  useEffect(() => {
    if (!visible || !foreground) return;
    setHasFrame(false);
    setControl(null);
    setError(null);
    frameRef.current = null;
    const interaction = createBrowserInteraction({
      send: (message) => streamRef.current?.send(message) ?? false,
      active: () =>
        pressedRef.current !== null || touchesRef.current.size > 0 || heldKeys.current.size > 0,
      error: setError,
    });
    interactionRef.current = interaction;
    const stream = createBrowserStream({
      threadRef,
      tabId,
      access: async () => {
        const connection = readPreparedConnection(threadRef.environmentId);
        if (!connection) throw new Error("The environment is disconnected.");
        return runtime.runPromise(
          resolveDeviceHubAccess({ prepared: connection, hubBasePath: "/api/browser" }),
        );
      },
      socket: (url) => new WebSocket(url),
      onMessage,
      onStatus: (next) => {
        setStatus(next);
        if (next !== "connected") {
          setControl(null);
          interaction.close();
          onHoldControlChange?.(false);
        }
      },
      onError: setError,
    });
    streamRef.current = stream;
    return () => {
      interaction.close();
      interactionRef.current = null;
      heldKeys.current.clear();
      stream.send({ type: "release_control" });
      stream.close();
      streamRef.current = null;
      frameRef.current = null;
      pressedRef.current = null;
      touchesRef.current.clear();
    };
  }, [threadRef.environmentId, threadRef.threadId, tabId, visible, foreground, prepared]);

  useEffect(() => {
    if (status !== "connected" || !surfaceRef.current || viewport?._tag !== "fill") return;
    const surface = surfaceRef.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resize = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        const rect = surface.getBoundingClientRect();
        const current = frameRef.current;
        const width = Math.max(1, Math.min(3840, Math.round(rect.width)));
        const height = Math.max(1, Math.min(3840, Math.round(rect.height)));
        if (current?.metadata.deviceWidth === width && current.metadata.deviceHeight === height)
          return;
        interactionRef.current?.send({
          type: "set_viewport",
          viewport: { _tag: "fill" },
          width,
          height,
        });
      }, 150);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(surface);
    resize();
    return () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [status, viewport?._tag]);

  const point = (clientX: number, clientY: number) => {
    const frame = frameRef.current;
    const rect = surfaceRef.current?.getBoundingClientRect();
    return frame && rect
      ? browserPoint({
          x: clientX - rect.left,
          y: clientY - rect.top,
          width: rect.width,
          height: rect.height,
          deviceWidth: frame.metadata.deviceWidth,
          deviceHeight: frame.metadata.deviceHeight,
        })
      : null;
  };

  const mouse = (
    event: PointerEvent<HTMLDivElement>,
    eventType: "mousePressed" | "mouseReleased" | "mouseMoved",
  ) => {
    if (!interactive) return;
    if (eventType === "mouseMoved" && event.buttons === 0 && !controlling) return;
    if (event.pointerType === "touch") {
      const position = point(event.clientX, event.clientY);
      if (eventType !== "mouseReleased" && !position) return;
      event.preventDefault();
      if (eventType === "mousePressed") {
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      if (eventType === "mouseReleased") touchesRef.current.delete(event.pointerId);
      else if (position)
        touchesRef.current.set(event.pointerId, { ...position, id: event.pointerId });
      sendInput({
        type: "input_touch",
        eventType:
          eventType === "mousePressed"
            ? "touchStart"
            : eventType === "mouseReleased"
              ? "touchEnd"
              : "touchMove",
        touchPoints: [...touchesRef.current.values()].slice(0, 10),
      });
      return;
    }
    const position =
      point(event.clientX, event.clientY) ??
      (eventType === "mouseReleased" ? pressedRef.current : null);
    if (!position) return;
    event.preventDefault();
    if (eventType === "mousePressed") {
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      pressedRef.current = {
        ...position,
        button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
      };
    }
    const button =
      eventType === "mouseReleased" && pressedRef.current
        ? pressedRef.current.button
        : eventType === "mouseMoved" && event.buttons === 0
          ? "none"
          : event.button === 2
            ? "right"
            : event.button === 1
              ? "middle"
              : "left";
    if (eventType === "mouseMoved" && pressedRef.current)
      pressedRef.current = { ...position, button: pressedRef.current.button };
    sendInput({
      type: "input_mouse",
      eventType,
      ...position,
      button,
      buttons: eventType === "mouseReleased" ? 0 : event.buttons,
      clickCount: eventType === "mouseMoved" ? 0 : Math.min(3, Math.max(1, event.detail)),
      modifiers: browserModifiers(event),
    });
    if (eventType === "mouseReleased") {
      pressedRef.current = null;
      interactionRef.current?.idle();
    }
  };

  const keyboard = (event: KeyboardEvent<HTMLDivElement>, eventType: "keyDown" | "keyUp") => {
    if (!interactive || event.nativeEvent.isComposing) return;
    if (eventType === "keyDown") heldKeys.current.add(event.code);
    else heldKeys.current.delete(event.code);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    sendInput({
      type: "input_keyboard",
      eventType,
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.keyCode,
      modifiers: browserModifiers(event),
      ...(eventType === "keyDown" &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
        ? { text: event.key }
        : {}),
    });
  };

  const wheel = useEffectEvent((event: WheelEvent) => {
    if (!interactive) return;
    const position = point(event.clientX, event.clientY);
    if (!position) return;
    event.preventDefault();
    sendInput({
      type: "input_mouse",
      eventType: "mouseWheel",
      ...position,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: browserModifiers(event),
    });
  });
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const listener = (event: WheelEvent) => wheel(event);
    surface.addEventListener("wheel", listener, { passive: false });
    return () => surface.removeEventListener("wheel", listener);
  }, []);

  return (
    <div className="flex size-full min-h-0 min-w-0 flex-col bg-background" data-server-browser>
      {error ? (
        <p
          role="alert"
          className="shrink-0 border-b border-border px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div
        ref={surfaceRef}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        tabIndex={interactive ? 0 : -1}
        role="application"
        data-browser-input-owner={interactive ? "" : undefined}
        aria-label="Environment browser"
        style={{ touchAction: interactive ? "none" : "auto" }}
        onPointerDown={(event) => mouse(event, "mousePressed")}
        onPointerUp={(event) => mouse(event, "mouseReleased")}
        onPointerMove={(event) => mouse(event, "mouseMoved")}
        onPointerCancel={(event) => mouse(event, "mouseReleased")}
        onLostPointerCapture={(event) => {
          if (pressedRef.current) mouse(event, "mouseReleased");
        }}
        onContextMenu={(event) => {
          if (interactive) event.preventDefault();
        }}
        onKeyDown={(event) => keyboard(event, "keyDown")}
        onKeyUp={(event) => keyboard(event, "keyUp")}
        onBlur={() => {
          for (const code of heldKeys.current) {
            sendInput({ type: "input_keyboard", eventType: "keyUp", code });
          }
          heldKeys.current.clear();
          interactionRef.current?.idle();
        }}
        onCompositionEnd={(event) => {
          if (interactive && event.data)
            sendInput({
              type: "input_keyboard",
              eventType: "char",
              text: event.data.slice(0, 65_536),
            });
        }}
        onPaste={(event) => {
          if (!interactive) return;
          event.preventDefault();
          sendInput({
            type: "input_keyboard",
            eventType: "char",
            text: event.clipboardData.getData("text/plain").slice(0, 65_536),
          });
        }}
      >
        <img
          ref={imageRef}
          alt="Live environment browser page"
          draggable={false}
          className="pointer-events-none size-full select-none object-contain"
          onLoad={() => {
            const frame = frameRef.current;
            if (!frame) return;
            setHasFrame(true);
            streamRef.current?.send({ type: "ack", seq: frame.seq });
          }}
          onError={() => {
            const frame = frameRef.current;
            if (frame) streamRef.current?.send({ type: "ack", seq: frame.seq });
          }}
        />
        {!hasFrame || status !== "connected" ? (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/80 px-4 text-center text-sm text-muted-foreground"
            role="status"
          >
            {status === "connected"
              ? "Waiting for the browser's first frame…"
              : status === "reconnecting"
                ? "Reconnecting to browser…"
                : "Connecting to browser…"}
          </div>
        ) : null}
      </div>
    </div>
  );
}
