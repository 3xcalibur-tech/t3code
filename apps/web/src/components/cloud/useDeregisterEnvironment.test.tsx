import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "../../confirmDialog";

const fixture = vi.hoisted(() => ({
  accountId: "account-a" as string | null,
  deregisterCommand: Symbol("deregister"),
  refreshCommand: Symbol("refresh"),
  deregister: vi.fn(),
  refresh: vi.fn(),
  refreshDiscovery: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../../cloud/managedRelayState", () => ({
  deregisterManagedRelayEnvironmentCommand: fixture.deregisterCommand,
  useManagedRelayEnvironments: () => ({
    accountId: fixture.accountId,
    refresh: fixture.refresh,
  }),
}));
vi.mock("../../state/relay", () => ({
  relayEnvironmentDiscovery: { refresh: fixture.refreshCommand },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === fixture.deregisterCommand ? fixture.deregister : fixture.refreshDiscovery,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: fixture.toast } }));

import { useDeregisterEnvironment } from "./useDeregisterEnvironment";

const environment = { environmentId: EnvironmentId.make("offline-host"), label: "Old laptop" };
let controller: ReturnType<typeof useDeregisterEnvironment>;
let renderer: ReactTestRenderer;
function Harness() {
  const value = useDeregisterEnvironment();
  useLayoutEffect(() => {
    controller = value;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  fixture.accountId = "account-a";
  fixture.deregister.mockResolvedValue(AsyncResult.success(undefined));
  fixture.refreshDiscovery.mockResolvedValue(AsyncResult.success(undefined));
  resetConfirmDialogForTests();
  registerConfirmDialogHost();
  await act(async () => {
    renderer = create(<Harness />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  resetConfirmDialogForTests();
  vi.unstubAllGlobals();
});

async function confirm(confirmed: boolean) {
  await act(async () => {
    respondToConfirmDialog(confirmed);
    completeConfirmDialogClose();
  });
}

describe("environment deregistration", () => {
  it("requires confirmation with the account-wide consequences, and cancel does nothing", async () => {
    const operation = controller.deregisterEnvironment(environment);
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      variant: "destructive",
      message: expect.stringContaining("Deregister Old laptop?"),
    });
    const state = readConfirmDialogState();
    expect(state.status !== "idle" && state.message).toContain("on all your devices");
    expect(state.status !== "idle" && state.message).toContain("Saved local connections are kept");
    expect(fixture.deregister).not.toHaveBeenCalled();
    await confirm(false);
    await operation;
    expect(fixture.deregister).not.toHaveBeenCalled();
    expect(fixture.refreshDiscovery).not.toHaveBeenCalled();
  });

  it("fails closed when there is no confirmation host", async () => {
    resetConfirmDialogForTests();
    await act(async () => controller.deregisterEnvironment(environment));
    expect(fixture.deregister).not.toHaveBeenCalled();
  });

  it("deregisters an offline host once, then refreshes account and discovery lists", async () => {
    let finish!: (value: ReturnType<typeof AsyncResult.success<void>>) => void;
    fixture.deregister.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const operation = controller.deregisterEnvironment(environment);
    await controller.deregisterEnvironment(environment);
    await confirm(true);
    expect(controller.deregisteringId).toBe(environment.environmentId);
    await controller.deregisterEnvironment(environment);
    expect(fixture.deregister).toHaveBeenCalledExactlyOnceWith({
      accountId: "account-a",
      environmentId: environment.environmentId,
    });
    expect(fixture.refresh).not.toHaveBeenCalled();
    await act(async () => {
      finish(AsyncResult.success(undefined));
      await operation;
    });
    expect(controller.deregisteringId).toBeNull();
    expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(fixture.refreshDiscovery).toHaveBeenCalledOnce();
    expect(fixture.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("keeps the entry on failure and permits retry", async () => {
    fixture.deregister.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Relay unavailable"))),
    );
    const first = controller.deregisterEnvironment(environment);
    await confirm(true);
    await first;
    expect(fixture.refresh).not.toHaveBeenCalled();
    expect(fixture.refreshDiscovery).not.toHaveBeenCalled();
    expect(fixture.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: "Relay unavailable",
      }),
    );
    const second = controller.deregisterEnvironment(environment);
    await confirm(true);
    await second;
    expect(fixture.deregister).toHaveBeenCalledTimes(2);
    expect(fixture.refresh).toHaveBeenCalledOnce();
  });

  it("requires sign-in before offering account deletion", async () => {
    fixture.accountId = null;
    await act(async () => renderer.update(<Harness />));
    await controller.deregisterEnvironment(environment);
    expect(readConfirmDialogState().status).toBe("idle");
    expect(fixture.deregister).not.toHaveBeenCalled();
    expect(fixture.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Sign in required" }),
    );
  });
});
