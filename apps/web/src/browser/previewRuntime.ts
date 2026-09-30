import type { EnvironmentId } from "@t3tools/contracts";

import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

/** Browser processes live beside the workspace; only the local desktop can use Electron. */
export function previewRuntimeForEnvironment(environmentId: EnvironmentId): "desktop" | "server" {
  return typeof window !== "undefined" &&
    Boolean(window.desktopBridge?.preview) &&
    !isLocalEnvironmentDisabled() &&
    appAtomRegistry.get(primaryEnvironmentIdAtom) === environmentId
    ? "desktop"
    : "server";
}
