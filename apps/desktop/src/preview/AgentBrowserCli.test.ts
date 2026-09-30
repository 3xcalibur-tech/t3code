// @effect-diagnostics nodeBuiltinImport:off -- Exercises real pinned native CLI processes and their owned socket receipts.
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  agentBrowserSocketDirectory,
  closeAgentBrowserSession,
  runAgentBrowser,
} from "@t3tools/shared/agentBrowserRuntime";
import { expect, it } from "vite-plus/test";
import { createAgentBrowserBridge } from "./AgentBrowserBridge.ts";

// Opt in to the real pinned CLI protocol test; the fake CDP guest never renders
// a browser and the normal suite never downloads a native release artifact.
it.runIf(Boolean(process.env.T3_AGENT_BROWSER_TEST_RUNTIME))(
  "pins the first native CLI attachment to the existing guest without creating a target",
  async () => {
    const directory = process.env.T3_AGENT_BROWSER_TEST_RUNTIME!;
    const session = `cli-${NodeCrypto.randomUUID().slice(0, 8)}`;
    const debuggerEmitter = new NodeEvents.EventEmitter();
    const methods: string[] = [];
    const bridge = await createAgentBrowserBridge({
      id: 123,
      debugger: debuggerEmitter as Electron.Debugger,
      url: () => "http://guest-only.test/",
      title: () => "Guest only",
    });
    bridge.activate(async (method, params) => {
      methods.push(method);
      if (method === "Runtime.evaluate")
        return {
          result: {
            type: params?.expression === "1" ? "number" : "string",
            value: params?.expression === "1" ? 1 : "http://guest-only.test/",
          },
        };
      return {};
    });
    try {
      const first = await runAgentBrowser({
        directory,
        session,
        cdp: bridge.endpoint,
        targetId: bridge.targetId,
        args: ["get", "url"],
        signal: AbortSignal.timeout(20_000),
      });
      expect(first).toEqual({ stdout: "http://guest-only.test/\n", stderr: "", exitCode: 0 });
      const second = await runAgentBrowser({
        directory,
        session,
        cdp: bridge.endpoint,
        targetId: bridge.targetId,
        args: ["get", "url"],
        signal: AbortSignal.timeout(20_000),
      });
      expect(second).toEqual(first);
      expect(methods).not.toContain("Target.createTarget");
    } finally {
      await closeAgentBrowserSession({ directory, session });
      await bridge.close();
    }
  },
);

it.runIf(Boolean(process.env.T3_AGENT_BROWSER_TEST_RUNTIME))(
  "waits for sidecar shutdown after cancelling an attached command",
  async () => {
    const directory = process.env.T3_AGENT_BROWSER_TEST_RUNTIME!;
    const session = `cancel-${NodeCrypto.randomUUID().slice(0, 8)}`;
    const emitter = new NodeEvents.EventEmitter();
    const started = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<Record<string, unknown>>();
    let holdCommand = false;
    const bridge = await createAgentBrowserBridge({
      id: 456,
      debugger: emitter as Electron.Debugger,
      url: () => "http://guest-only.test/",
      title: () => "Guest only",
    });
    bridge.activate(async (method, params) => {
      if (method === "Runtime.evaluate" && params?.expression !== "1") {
        if (holdCommand) {
          started.resolve();
          return await blocked.promise;
        }
        return { result: { type: "string", value: "http://guest-only.test/" } };
      }
      if (method === "Runtime.evaluate") return { result: { type: "number", value: 1 } };
      return {};
    });
    try {
      await runAgentBrowser({
        directory,
        session,
        cdp: bridge.endpoint,
        targetId: bridge.targetId,
        args: ["get", "url"],
        signal: AbortSignal.timeout(20_000),
      });
      holdCommand = true;
      const controller = new AbortController();
      const pending = runAgentBrowser({
        directory,
        session,
        cdp: bridge.endpoint,
        targetId: bridge.targetId,
        args: ["get", "url"],
        signal: controller.signal,
      });
      const rejected = expect(pending).rejects.toThrow();
      await started.promise;
      // The host disables the old CDP transport before interrupting its CLI.
      bridge.disconnect();
      controller.abort(new Error("Human took control."));
      await rejected;
      await expect(
        NodeFSP.access(NodePath.join(agentBrowserSocketDirectory(directory), `${session}.pid`)),
      ).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      blocked.resolve({ result: { type: "string", value: "http://guest-only.test/" } });
      await closeAgentBrowserSession({ directory, session });
      await bridge.close();
    }
  },
);
