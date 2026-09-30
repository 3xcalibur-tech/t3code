import {
  browserPoint,
  createBrowserStream,
  type BrowserControl,
  type BrowserFrame,
  type BrowserStreamStatus,
} from "@t3tools/client-runtime/browser-stream";
import { resolveDeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { PreviewBrowserClientMessage, ScopedThreadRef } from "@t3tools/contracts";
import { Image } from "expo-image";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState, type Ref } from "react";
import { AppState, View, type GestureResponderEvent } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import {
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbar";
import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession, usePreparedConnection } from "../../state/session";

interface BrowserImageHandle {
  readonly display: (frame: BrowserFrame | null) => void;
}

/** Isolate media updates so frames do not rerender the address and sign-in controls. */
function BrowserImage({
  ref,
  tabId,
  acknowledge,
}: {
  readonly ref: Ref<BrowserImageHandle>;
  readonly tabId: string;
  readonly acknowledge: (seq: number) => void;
}) {
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  useImperativeHandle(ref, () => ({ display: setFrame }), []);
  return frame ? (
    <Image
      pointerEvents="none"
      accessibilityLabel="Live browser page on this environment"
      source={{
        uri: `data:image/jpeg;base64,${frame.data}`,
        cacheKey: `browser:${tabId}:${frame.seq}`,
      }}
      contentFit="contain"
      cachePolicy="none"
      style={{ width: "100%", height: "100%" }}
      onDisplay={() => acknowledge(frame.seq)}
      onError={() => acknowledge(frame.seq)}
    />
  ) : null;
}

export function ServerBrowserView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly visible: boolean;
  readonly url: string;
}) {
  const frameRef = useRef<BrowserFrame | null>(null);
  const imageRef = useRef<BrowserImageHandle | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [status, setStatus] = useState<BrowserStreamStatus>("connecting");
  const [control, setControl] = useState<BrowserControl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [privateInput, setPrivateInput] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const streamRef = useRef<ReturnType<typeof createBrowserStream> | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const prepared = usePreparedConnection(props.threadRef.environmentId);
  const controlling =
    status === "connected" && control !== null && control.viewerId === control.controller;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);

  const onMessage = useEffectEvent(
    (message: Parameters<Parameters<typeof createBrowserStream>[0]["onMessage"]>[0]) => {
      if (message.type === "frame") {
        frameRef.current = message;
        imageRef.current?.display(message);
        setHasFrame(true);
      }
      if (message.type === "control") {
        setControl(message);
        setError(null);
      }
      if (message.type === "error") setError(message.message);
    },
  );

  useEffect(() => {
    if (!props.visible || !foreground) return;
    frameRef.current = null;
    imageRef.current?.display(null);
    setHasFrame(false);
    setControl(null);
    setError(null);
    const stream = createBrowserStream({
      threadRef: props.threadRef,
      tabId: props.tabId,
      access: async () => {
        const connection = Option.getOrNull(
          appAtomRegistry.get(
            environmentSession.preparedConnectionValueAtom(props.threadRef.environmentId),
          ),
        );
        if (!connection) throw new Error("The environment is disconnected.");
        return runtime.runPromise(
          resolveDeviceHubAccess({ prepared: connection, hubBasePath: "/api/browser" }),
        );
      },
      socket: (url) => new WebSocket(url),
      onMessage,
      onStatus: (next) => {
        setStatus(next);
        if (next !== "connected") setControl(null);
      },
      onError: setError,
    });
    streamRef.current = stream;
    return () => {
      stream.send({ type: "release_control" });
      stream.close();
      streamRef.current = null;
      setControl(null);
      setText("");
    };
  }, [
    props.threadRef.environmentId,
    props.threadRef.threadId,
    props.tabId,
    props.visible,
    foreground,
    prepared,
  ]);

  useEffect(() => {
    if (!controlling) setText("");
  }, [controlling]);

  const send = (message: PreviewBrowserClientMessage) => {
    if (!controlling) {
      setError("Take control to interact with the browser.");
      return;
    }
    streamRef.current?.send(message);
  };
  const press = (key: string, code: string, windowsVirtualKeyCode: number) => {
    send({ type: "input_keyboard", eventType: "keyDown", key, code, windowsVirtualKeyCode });
    send({ type: "input_keyboard", eventType: "keyUp", key, code, windowsVirtualKeyCode });
  };
  const touch = (
    event: GestureResponderEvent,
    eventType: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
  ) => {
    const frame = frameRef.current;
    if (!controlling || !frame) return;
    const touchPoints =
      eventType === "touchEnd" || eventType === "touchCancel"
        ? []
        : event.nativeEvent.touches.flatMap((item) => {
            const position = browserPoint({
              x: item.locationX,
              y: item.locationY,
              ...sizeRef.current,
              deviceWidth: frame.metadata.deviceWidth,
              deviceHeight: frame.metadata.deviceHeight,
            });
            return position ? [{ ...position, id: Number(item.identifier) }] : [];
          });
    if ((eventType === "touchStart" || eventType === "touchMove") && touchPoints.length === 0)
      return;
    send({ type: "input_touch", eventType, touchPoints });
  };

  return (
    <View className="flex-1 bg-screen">
      <View className="gap-2 border-b border-border-subtle px-3 py-2">
        <View className="flex-row items-center justify-between gap-2">
          <Text selectable className="min-w-0 flex-1 text-sm text-foreground-muted">
            {status !== "connected"
              ? "Connecting to browser…"
              : controlling
                ? "You control this browser"
                : control?.controller
                  ? "Another viewer has control"
                  : "Watching the agent's browser"}
          </Text>
          <ComposerToolbarButton
            label={controlling ? "Return to agent" : "Take control"}
            showChevron={false}
            disabled={
              status !== "connected" ||
              control === null ||
              (control.controller !== null && !controlling)
            }
            onPress={() =>
              streamRef.current?.send({ type: controlling ? "release_control" : "take_control" })
            }
          />
        </View>
        <View className="flex-row items-center gap-2">
          <TextInput
            accessibilityLabel="Browser address"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            editable={controlling}
            className="min-h-11 min-w-0 flex-1 rounded-xl bg-subtle px-3 text-base text-foreground"
            value={urlDraft ?? props.url}
            onChangeText={setUrlDraft}
            onSubmitEditing={() => {
              const raw = (urlDraft ?? props.url).trim();
              if (!raw) return;
              try {
                send({ type: "navigate", url: normalizePreviewUrl(raw) });
              } catch {
                setError("Enter a valid browser address.");
              }
              setUrlDraft(null);
            }}
            maxLength={2048}
          />
          <ComposerToolbarButton
            icon="arrow.clockwise"
            accessibilityLabel="Reload browser page"
            showChevron={false}
            disabled={!controlling}
            onPress={() => send({ type: "reload" })}
          />
        </View>
        {error ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger">
            {error}
          </Text>
        ) : null}
      </View>
      <View
        className="relative min-h-0 flex-1 bg-subtle"
        onLayout={(event) => {
          sizeRef.current = event.nativeEvent.layout;
        }}
        onStartShouldSetResponder={() => controlling}
        onMoveShouldSetResponder={() => controlling}
        onResponderGrant={(event) => touch(event, "touchStart")}
        onResponderMove={(event) => touch(event, "touchMove")}
        onResponderRelease={(event) => touch(event, "touchEnd")}
        onResponderTerminate={(event) => touch(event, "touchCancel")}
        onResponderTerminationRequest={() => false}
      >
        <BrowserImage
          ref={imageRef}
          tabId={props.tabId}
          acknowledge={(seq) => {
            streamRef.current?.send({ type: "ack", seq });
          }}
        />
        {!hasFrame || status !== "connected" ? (
          <View
            pointerEvents="none"
            className="absolute inset-0 items-center justify-center bg-screen/80 px-6"
          >
            <Text selectable className="text-center text-sm text-foreground-muted">
              {status === "connected"
                ? "Waiting for the browser's first frame…"
                : status === "reconnecting"
                  ? "Reconnecting to browser…"
                  : "Connecting to browser…"}
            </Text>
          </View>
        ) : null}
      </View>
      {controlling ? (
        <View className="gap-2 border-t border-border-subtle px-3 py-2">
          <View className="flex-row items-center gap-2">
            <TextInput
              accessibilityLabel="Text to enter in the focused browser field"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={privateInput}
              className="min-h-11 min-w-0 flex-1 rounded-xl bg-subtle px-3 text-base text-foreground"
              placeholder="Tap a field on the page, then type here"
              value={text}
              onChangeText={setText}
              onSubmitEditing={() => {
                if (text) send({ type: "input_keyboard", eventType: "char", text });
                setText("");
              }}
              maxLength={65_536}
              returnKeyType="send"
            />
            <ComposerToolbarButton
              icon={privateInput ? "eye" : "eye"}
              accessibilityLabel={privateInput ? "Show typed text" : "Hide typed text"}
              showChevron={false}
              onPress={() => setPrivateInput((value) => !value)}
            />
            <ComposerToolbarButton
              label="Type"
              showChevron={false}
              disabled={text.length === 0}
              onPress={() => {
                send({ type: "input_keyboard", eventType: "char", text });
                setText("");
              }}
            />
          </View>
          <ComposerToolbarScroller>
            <ComposerToolbarRow>
              <ComposerToolbarButton
                icon="chevron.left"
                accessibilityLabel="Browser back"
                showChevron={false}
                onPress={() => send({ type: "back" })}
              />
              <ComposerToolbarButton
                icon="chevron.right"
                accessibilityLabel="Browser forward"
                showChevron={false}
                onPress={() => send({ type: "forward" })}
              />
              <ComposerToolbarButton
                label="Tab"
                showChevron={false}
                onPress={() => press("Tab", "Tab", 9)}
              />
              <ComposerToolbarButton
                label="Enter"
                showChevron={false}
                onPress={() => press("Enter", "Enter", 13)}
              />
              <ComposerToolbarButton
                icon="arrow.left"
                accessibilityLabel="Browser backspace"
                showChevron={false}
                onPress={() => press("Backspace", "Backspace", 8)}
              />
              <ComposerToolbarButton
                label="Escape"
                showChevron={false}
                onPress={() => press("Escape", "Escape", 27)}
              />
              <ComposerToolbarButton
                label="Fit viewport"
                showChevron={false}
                onPress={() =>
                  send({
                    type: "resize",
                    width: Math.max(1, Math.min(3840, Math.round(sizeRef.current.width))),
                    height: Math.max(1, Math.min(3840, Math.round(sizeRef.current.height))),
                  })
                }
              />
            </ComposerToolbarRow>
          </ComposerToolbarScroller>
        </View>
      ) : null}
    </View>
  );
}
