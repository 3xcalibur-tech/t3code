import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const primary = vi.hoisted(() => ({ id: "local" as string | null }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => primary.id } }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));

import { previewRuntimeForEnvironment } from "./previewRuntime";

beforeEach(() => {
  primary.id = "local";
});
afterEach(() => vi.unstubAllGlobals());

describe("browser process ownership", () => {
  it("uses native Electron only for its enabled local environment", () => {
    vi.stubGlobal("window", {
      desktopBridge: { preview: {}, getLocalEnvironmentEnabled: () => true },
    });
    expect(previewRuntimeForEnvironment(EnvironmentId.make("local"))).toBe("desktop");
    expect(previewRuntimeForEnvironment(EnvironmentId.make("remote"))).toBe("server");
  });

  it("keeps browser clients, unknown primaries, and disabled local environments on the server", () => {
    vi.stubGlobal("window", {});
    expect(previewRuntimeForEnvironment(EnvironmentId.make("local"))).toBe("server");
    vi.stubGlobal("window", {
      desktopBridge: { preview: {}, getLocalEnvironmentEnabled: () => false },
    });
    expect(previewRuntimeForEnvironment(EnvironmentId.make("local"))).toBe("server");
    primary.id = null;
    vi.stubGlobal("window", { desktopBridge: { preview: {} } });
    expect(previewRuntimeForEnvironment(EnvironmentId.make("local"))).toBe("server");
  });
});
