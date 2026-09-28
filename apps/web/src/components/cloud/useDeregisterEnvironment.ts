import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import {
  deregisterManagedRelayEnvironmentCommand,
  useManagedRelayEnvironments,
} from "../../cloud/managedRelayState";
import { requestConfirmDialog } from "../../confirmDialog";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/** Account deregistration works even when the environment cannot be reached. */
export function useDeregisterEnvironment() {
  const environments = useManagedRelayEnvironments();
  const deregister = useAtomCommand(deregisterManagedRelayEnvironmentCommand, {
    reportFailure: false,
  });
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const pending = useRef(false);
  const [deregisteringId, setDeregisteringId] = useState<EnvironmentId | null>(null);

  const deregisterEnvironment = async (environment: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }) => {
    if (pending.current) return;
    const accountId = environments.accountId;
    if (!accountId) {
      toastManager.add({
        type: "error",
        title: "Sign in required",
        description: "Sign in to T3 Connect to deregister this device.",
      });
      return;
    }

    pending.current = true;
    try {
      const confirmed = await requestConfirmDialog(
        `Deregister ${environment.label}?\nThis device will be removed from T3 Connect. To reconnect, set up T3 Connect on that device again.`,
        { variant: "destructive" },
      );
      if (confirmed !== true) return;

      setDeregisteringId(environment.environmentId);
      const result = await deregister({ accountId, environmentId: environment.environmentId });
      if (result._tag === "Success") {
        environments.refresh();
        await refreshDiscovery();
        toastManager.add({
          type: "success",
          title: "Device deregistered",
          description: "T3 Connect access was revoked and a host slot is now available.",
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not deregister device",
          description: cause instanceof Error ? cause.message : "Please try again.",
        });
      }
    } finally {
      pending.current = false;
      setDeregisteringId(null);
    }
  };

  return { deregisterEnvironment, deregisteringId };
}
