import * as NodeCrypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

type Send = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

/** Presents one Electron guest as a CDP browser without exposing the app's other targets. */
export async function createAgentBrowserBridge(input: {
  id: number;
  debugger: Electron.Debugger;
  url: () => string;
  title: () => string;
}) {
  const targetId = `t3-preview-${input.id}`;
  const rootSession = `t3-preview-session-${input.id}`;
  const path = `/${NodeCrypto.randomUUID()}`;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path, maxPayload: 1_000_000 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not create the preview browser bridge.");
  const children = new Set<string>();
  let activeSend: Send | undefined;
  const targetInfo = () => ({
    targetId,
    type: "page",
    title: input.title(),
    url: input.url(),
    attached: true,
    canAccessOpener: false,
  });
  const onMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => {
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string")
      children.add(params.sessionId);
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string")
      children.delete(params.sessionId);
    const message = JSON.stringify({ method, params, sessionId: sessionId ?? rootSession });
    for (const client of server.clients)
      if (client.readyState === WebSocket.OPEN) client.send(message);
  };
  input.debugger.on("message", onMessage);
  server.on("connection", (client) => {
    client.on("error", () => {});
    client.on("message", async (data) => {
      let command: {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      try {
        command = JSON.parse(data.toString());
      } catch {
        client.close(1003, "Invalid CDP message");
        return;
      }
      if (typeof command.id !== "number" || typeof command.method !== "string") return;
      const { id, method, params, sessionId } = command;
      const respond = (body: Record<string, unknown>) => {
        if (client.readyState === WebSocket.OPEN)
          client.send(JSON.stringify({ id, ...body, ...(sessionId ? { sessionId } : {}) }));
      };
      try {
        if (sessionId && sessionId !== rootSession && !children.has(sessionId))
          throw new Error("This session is outside the preview guest.");
        if (method === "Browser.getVersion") {
          respond({
            result: {
              protocolVersion: "1.3",
              product: `Chrome/${process.versions.chrome}`,
              revision: "",
              userAgent: "T3 Preview",
              jsVersion: process.versions.v8,
            },
          });
          return;
        }
        if (!activeSend) throw new Error("Preview agent control is inactive.");
        let result: unknown;
        if (method === "Target.getTargets") result = { targetInfos: [targetInfo()] };
        else if (method === "Target.getTargetInfo") {
          if (params?.targetId && params.targetId !== targetId)
            throw new Error("Target is outside the preview guest.");
          result = { targetInfo: targetInfo() };
        } else if (method === "Target.attachToTarget") {
          if (params?.targetId !== targetId)
            throw new Error("Target is outside the preview guest.");
          result = { sessionId: rootSession };
        } else if (
          method === "Target.setDiscoverTargets" ||
          (method === "Target.setAutoAttach" && !sessionId) ||
          method === "Target.detachFromTarget"
        )
          result = {};
        else if (method === "Target.activateTarget") {
          if (params?.targetId !== targetId)
            throw new Error("Target is outside the preview guest.");
          result = {};
        } else {
          const domain = method.split(".")[0];
          const permitted = [
            "Accessibility",
            "CSS",
            "DOM",
            "DOMSnapshot",
            "Debugger",
            "Emulation",
            "Fetch",
            "Input",
            "Log",
            "Network",
            "Overlay",
            "Page",
            "Performance",
            "Runtime",
            "Security",
            "Storage",
            "WebMCP",
          ];
          if (!permitted.includes(domain!) && !(method === "Target.setAutoAttach" && sessionId))
            throw new Error(`CDP command ${method} is outside the preview guest.`);
          result = await activeSend(
            method,
            params,
            sessionId === rootSession ? undefined : sessionId,
          );
        }
        respond({ result: result ?? {} });
      } catch (error) {
        respond({
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        });
      }
    });
  });
  return {
    endpoint: `ws://127.0.0.1:${address.port}${path}`,
    targetId,
    activate(send: Send) {
      activeSend = send;
    },
    deactivate() {
      activeSend = undefined;
    },
    disconnect() {
      activeSend = undefined;
      for (const client of server.clients) client.terminate();
    },
    async close() {
      activeSend = undefined;
      input.debugger.off("message", onMessage);
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type AgentBrowserBridge = Awaited<ReturnType<typeof createAgentBrowserBridge>>;
