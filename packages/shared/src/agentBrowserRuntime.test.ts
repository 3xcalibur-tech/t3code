// @effect-diagnostics nodeBuiltinImport:off -- Exercises the native runtime cache without provisioning a browser.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  agentBrowserEnvironment,
  agentBrowserSocketDirectory,
  closeAgentBrowserSession,
  ensureTargetBinding,
} from "./agentBrowserRuntime.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("managed agent-browser runtime", () => {
  it("rebinds a reopened tab after the previous sidecar has exited", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-rebind-"));
    try {
      await ensureTargetBinding(directory, "reopened", "old-target");
      await ensureTargetBinding(directory, "reopened", "new-target");
      expect(
        JSON.parse(await NodeFSP.readFile(NodePath.join(directory, "reopened.target"), "utf8")),
      ).toEqual({ targetId: "new-target", url: "", pinned: true });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
  it("clears inherited browser targeting and retains the process environment", () => {
    vi.stubEnv("AGENT_BROWSER_CDP", "ws://other-browser");
    vi.stubEnv("AGENT_BROWSER_PROFILE", "/personal");
    vi.stubEnv("AGENT_BROWSER_PROVIDER", "browserbase");
    vi.stubEnv("AGENT_BROWSER_SESSION", "other-task");
    vi.stubEnv("T3_RUNTIME_TEST_VALUE", "kept");
    const environment = agentBrowserEnvironment("/tmp/owned-sockets");
    expect(environment).not.toHaveProperty("AGENT_BROWSER_CDP");
    expect(environment).not.toHaveProperty("AGENT_BROWSER_PROFILE");
    expect(environment).not.toHaveProperty("AGENT_BROWSER_PROVIDER");
    expect(environment).not.toHaveProperty("AGENT_BROWSER_SESSION");
    expect(environment).toHaveProperty("T3_RUNTIME_TEST_VALUE", "kept");
    expect(environment.AGENT_BROWSER_SOCKET_DIR).toBe("/tmp/owned-sockets");
  });

  it("keeps native socket addresses short for long worktree paths and isolates environments", () => {
    const first = agentBrowserSocketDirectory(`/home/user/${"worktree/".repeat(100)}one`);
    const second = agentBrowserSocketDirectory(`/home/user/${"worktree/".repeat(100)}two`);
    expect(first).not.toBe(second);
    expect(NodePath.join(first, "t3-desktop-123-123456789abc.sock").length).toBeLessThan(108);
  });

  it("does not download or start a sidecar when closing an unused session", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-agent-browser-close-"),
    );
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      expect(await closeAgentBrowserSession({ directory, session: "unused" })).toEqual({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
