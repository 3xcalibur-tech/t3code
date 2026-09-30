import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId, type PreviewSessionSnapshot } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import {
  ComposerToolbarButton,
  ComposerToolbarScroller,
  ComposerToolbarRow,
} from "../../components/ComposerToolbar";
import { EmptyState } from "../../components/EmptyState";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

import { ServerBrowserView } from "./ServerBrowserView";

type Props = StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }>;

export function ThreadBrowserRouteScreen({ route }: Props) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const threadRef = {
    environmentId: EnvironmentId.make(route.params.environmentId),
    threadId: ThreadId.make(route.params.threadId),
  };
  const threadIdentity = JSON.stringify([threadRef.environmentId, threadRef.threadId]);
  const identityRef = useRef(threadIdentity);
  identityRef.current = threadIdentity;
  const list = useEnvironmentQuery(
    previewEnvironment.list({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const events = useAtomValue(
    previewEnvironment.events({ environmentId: threadRef.environmentId, input: {} }),
  );
  const open = useAtomCommand(previewEnvironment.open);
  const close = useAtomCommand(previewEnvironment.close);
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [opened, setOpened] = useState<PreviewSessionSnapshot | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [visible, setVisible] = useState(false);
  const epochRef = useRef<string | null>(null);
  const refresh = list.refresh;
  useEffect(() => {
    setOpened(null);
    setSelectedTabId(null);
    setUrl("");
    setError(null);
    setPending(false);
    epochRef.current = null;
  }, [threadIdentity]);
  useFocusEffect(
    useCallback(() => {
      setVisible(true);
      refresh();
      return () => setVisible(false);
    }, [refresh]),
  );
  const applyEvent = useEffectEvent(() => {
    if (events._tag === "Success" && events.value.threadId === threadRef.threadId) {
      if (events.value.type === "closed" && opened?.tabId === events.value.tabId) setOpened(null);
      list.refresh();
    }
  });
  useEffect(() => {
    applyEvent();
  }, [events]);
  useEffect(() => {
    if (opened && list.data?.sessions.some((session) => session.tabId === opened.tabId))
      setOpened(null);
    if (list.data) {
      if (epochRef.current !== null && epochRef.current !== list.data.serverEpoch) {
        setOpened(null);
        setSelectedTabId(null);
      }
      epochRef.current = list.data.serverEpoch;
    }
  }, [list.data, opened]);
  const listedSessions = list.data?.sessions ?? [];
  const sessions =
    opened && !listedSessions.some((session) => session.tabId === opened.tabId)
      ? [...listedSessions, opened]
      : listedSessions;
  const snapshot =
    sessions.find((session) => session.tabId === selectedTabId) ?? sessions.at(-1) ?? null;

  const openTab = async () => {
    if (pending) return;
    const targetIdentity = threadIdentity;
    let initialUrl: string | undefined;
    try {
      initialUrl = url.trim() ? normalizePreviewUrl(url) : undefined;
    } catch {
      setError("Enter a valid browser address.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await open({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        runtime: "server",
        ...(initialUrl ? { url: initialUrl } : {}),
      },
    });
    if (identityRef.current !== targetIdentity) return;
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Unable to open the browser.");
      return;
    }
    setOpened(result.value);
    setUrl("");
    setSelectedTabId(result.value.tabId);
    list.refresh();
  };

  return (
    <View className="flex-1 bg-screen" style={{ paddingBottom: insets.bottom }}>
      <NativeStackScreenOptions
        options={{ title: "Browser", headerShown: Platform.OS !== "android" }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title="Browser" onBack={() => navigation.goBack()} />
      ) : null}
      <ComposerToolbarScroller>
        <ComposerToolbarRow>
          {sessions.map((session) => (
            <ComposerToolbarButton
              key={session.tabId}
              label={
                session.navStatus._tag === "Idle"
                  ? "New tab"
                  : session.navStatus.title || session.navStatus.url
              }
              maxWidth={180}
              active={snapshot?.tabId === session.tabId}
              showChevron={false}
              onPress={() => setSelectedTabId(session.tabId)}
            />
          ))}
          <ComposerToolbarButton
            icon="plus"
            label="New tab"
            disabled={pending}
            showChevron={false}
            onPress={() => void openTab()}
          />
          {snapshot ? (
            <ComposerToolbarButton
              icon="xmark"
              accessibilityLabel="Close browser tab"
              showChevron={false}
              onPress={() => {
                const targetIdentity = threadIdentity;
                void close({
                  environmentId: threadRef.environmentId,
                  input: { threadId: threadRef.threadId, tabId: snapshot.tabId },
                }).then((result) => {
                  if (identityRef.current !== targetIdentity) return;
                  if (result._tag === "Failure") {
                    const failure = squashAtomCommandFailure(result);
                    setError(
                      failure instanceof Error ? failure.message : "Unable to close this tab.",
                    );
                    return;
                  }
                  setOpened(null);
                  setSelectedTabId(null);
                  list.refresh();
                });
              }}
            />
          ) : null}
        </ComposerToolbarRow>
      </ComposerToolbarScroller>
      {(error ?? list.error) ? (
        <Text selectable accessibilityRole="alert" className="px-3 py-2 text-sm text-danger">
          {error ?? list.error}
        </Text>
      ) : null}
      {snapshot ? (
        <ServerBrowserView
          key={snapshot.tabId}
          threadRef={threadRef}
          tabId={snapshot.tabId}
          visible={visible}
          url={snapshot.navStatus._tag === "Idle" ? "" : snapshot.navStatus.url}
        />
      ) : (
        <View className="flex-1 justify-center gap-4 px-6">
          <EmptyState
            title="Browse on this environment"
            detail="Open a browser beside your project, or watch the browser your agent opens. Take control when a page needs you to sign in."
          />
          <TextInput
            accessibilityLabel="Initial browser address"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            className="min-h-11 rounded-xl bg-subtle px-3 text-base text-foreground"
            placeholder="http://localhost:3000"
            value={url}
            onChangeText={setUrl}
            onSubmitEditing={() => void openTab()}
          />
          <ComposerToolbarButton
            label={pending ? "Opening browser…" : "Open browser"}
            icon="globe"
            showChevron={false}
            disabled={pending}
            onPress={() => void openTab()}
          />
        </View>
      )}
    </View>
  );
}
