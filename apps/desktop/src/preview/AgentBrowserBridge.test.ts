import * as NodeEvents from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vite-plus/test";
import { createAgentBrowserBridge } from "./AgentBrowserBridge.ts";

async function connect(endpoint: string) {
  const client = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  let sequence = 0;
  return {
    client,
    command(method: string, params?: Record<string, unknown>, sessionId?: string) {
      const id = ++sequence;
      return new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>(
        (resolve) => {
          const listener = (bytes: Buffer) => {
            const result = JSON.parse(bytes.toString());
            if (result.id !== id) return;
            client.off("message", listener);
            resolve(result);
          };
          client.on("message", listener);
          client.send(JSON.stringify({ id, method, params, sessionId }));
        },
      );
    },
  };
}

describe("preview agent-browser CDP bridge", () => {
  it("discovers and attaches only the existing guest, without attaching another Electron debugger", async () => {
    const debuggerEmitter = new NodeEvents.EventEmitter();
    const send = vi.fn(async () => ({ value: 42 }));
    const bridge = await createAgentBrowserBridge({
      id: 21,
      debugger: debuggerEmitter as Electron.Debugger,
      url: () => "http://localhost:5173/",
      title: () => "Preview",
    });
    const { client, command } = await connect(bridge.endpoint);
    try {
      bridge.activate(send);
      const targets = await command("Target.getTargets");
      expect(targets.result?.targetInfos).toEqual([
        {
          targetId: bridge.targetId,
          type: "page",
          title: "Preview",
          url: "http://localhost:5173/",
          attached: true,
          canAccessOpener: false,
        },
      ]);
      const attached = await command("Target.attachToTarget", {
        targetId: bridge.targetId,
        flatten: true,
      });
      const session = attached.result?.sessionId as string;
      expect((await command("Runtime.evaluate", { expression: "42" }, session)).result).toEqual({
        value: 42,
      });
      expect(send).toHaveBeenCalledExactlyOnceWith(
        "Runtime.evaluate",
        { expression: "42" },
        undefined,
      );
      expect(
        (await command("Target.attachToTarget", { targetId: "shell" })).error?.message,
      ).toContain("outside");
      expect(
        (await command("Target.createTarget", { url: "about:blank" })).error?.message,
      ).toContain("outside");
      expect((await command("Browser.close")).error?.message).toContain("outside");
      expect((await command("Runtime.evaluate", {}, "shell-session")).error?.message).toContain(
        "outside",
      );
      expect(send).toHaveBeenCalledTimes(1);
      bridge.deactivate();
      expect(
        (await command("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 }, session))
          .error?.message,
      ).toContain("inactive");
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      client.terminate();
      await bridge.close();
    }
    expect(debuggerEmitter.listenerCount("message")).toBe(0);
  });

  it("forwards only sessions attached underneath the guest and terminates access at takeover", async () => {
    const debuggerEmitter = new NodeEvents.EventEmitter();
    const send = vi.fn(async () => ({}));
    const bridge = await createAgentBrowserBridge({
      id: 22,
      debugger: debuggerEmitter as Electron.Debugger,
      url: () => "http://localhost/",
      title: () => "Preview",
    });
    const { client, command } = await connect(bridge.endpoint);
    try {
      bridge.activate(send);
      const attached = await command("Target.attachToTarget", { targetId: bridge.targetId });
      debuggerEmitter.emit("message", {}, "Target.attachedToTarget", {
        sessionId: "child-frame",
        targetInfo: { type: "iframe" },
      });
      await command("Runtime.evaluate", {}, "child-frame");
      expect(send).toHaveBeenCalledWith("Runtime.evaluate", {}, "child-frame");
      debuggerEmitter.emit("message", {}, "Target.detachedFromTarget", {
        sessionId: "child-frame",
      });
      expect((await command("Runtime.evaluate", {}, "child-frame")).error?.message).toContain(
        "outside",
      );
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      bridge.disconnect();
      await closed;
      expect(attached.result?.sessionId).toBeDefined();
    } finally {
      client.terminate();
      await bridge.close();
    }
  });
});
