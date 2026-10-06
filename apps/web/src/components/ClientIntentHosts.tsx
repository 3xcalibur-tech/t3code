import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { subscribeDynamic } from "@t3tools/client-runtime/rpc";
import { createEnvironmentSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { clientIntentWindowId } from "~/lib/backgroundActivityReporter";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useRightPanelStore } from "~/rightPanelStore";
import type { AppRouter } from "~/router";
import { useEnvironments } from "~/state/environments";
import { buildThreadRouteParams } from "~/threadRoutes";

const clientIntents = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:client-intents",
  subscribe: () =>
    subscribeDynamic(WS_METHODS.subscribeClientIntents, () =>
      Effect.sync(() => ({
        clientId: clientIntentWindowId,
        focused: document.hasFocus(),
      })),
    ),
  // Intents are commands, not cached data: a remount must not replay the last one.
  idleTtlMs: 0,
});

/** Acts on server requests to show a thread, such as an agent's t3_client_open_thread call. */
export function ClientIntentHosts({ router }: { readonly router: AppRouter }) {
  const { environments } = useEnvironments();
  return (
    <>
      {environments.map((environment) => (
        <ClientIntentHost
          key={environment.environmentId}
          environmentId={environment.environmentId}
          router={router}
        />
      ))}
    </>
  );
}

function ClientIntentHost(props: {
  readonly environmentId: EnvironmentId;
  readonly router: AppRouter;
}) {
  const { environmentId, router } = props;
  const intent = Option.getOrNull(
    AsyncResult.value(useAtomValue(clientIntents({ environmentId, input: {} }))),
  );
  const handledIntentIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      intent === null ||
      intent.environmentId !== environmentId ||
      handledIntentIdRef.current === intent.intentId
    )
      return;
    handledIntentIdRef.current = intent.intentId;
    // Every open window receives the intent. The window the user focused last moves even
    // while a terminal has focus; otherwise only the window the user is looking at does.
    const targeted =
      intent.targetClientId !== undefined && intent.targetClientId === clientIntentWindowId;
    if (!targeted && (document.visibilityState !== "visible" || !document.hasFocus())) return;
    const threadRef = scopeThreadRef(environmentId, intent.threadId);
    if (intent.panel !== undefined) useRightPanelStore.getState().open(threadRef, intent.panel);
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  }, [environmentId, intent, router]);
  return null;
}
