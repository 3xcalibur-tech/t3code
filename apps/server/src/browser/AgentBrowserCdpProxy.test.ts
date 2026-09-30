// @effect-diagnostics nodeBuiltinImport:off - Loopback sockets exercise the external daemon's authority boundary.
import * as NodeWs from "ws";
import { expect, it } from "vite-plus/test";
import { createAgentBrowserCdpProxy } from "./AgentBrowserCdpProxy.ts";

const next = (socket: NodeWs.WebSocket, event: "open" | "close" | "message") =>
  new Promise<unknown[]>((resolve, reject) => {
    socket.once(event, (...args: unknown[]) => resolve(args));
    socket.once("error", reject);
  });

const fixture = async () => {
  const upstream = new NodeWs.WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    upstream.once("listening", resolve);
    upstream.once("error", reject);
  });
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No test CDP port");
  const received: string[] = [];
  upstream.on("connection", (socket) =>
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        id: number;
        method: string;
        sessionId?: string;
      };
      received.push(request.method);
      const result =
        request.method === "Target.getTargets"
          ? { targetInfos: [{ targetId: "ours" }, { targetId: "other" }] }
          : request.method === "Target.attachToTarget"
            ? { sessionId: "our-session" }
            : { value: "ok" };
      socket.send(
        JSON.stringify({
          id: request.id,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          result,
        }),
      );
    }),
  );
  const proxy = await createAgentBrowserCdpProxy({
    upstream: `ws://127.0.0.1:${address.port}`,
    targetId: "ours",
  });
  const clients: NodeWs.WebSocket[] = [];
  const connect = async () => {
    const client = new NodeWs.WebSocket(proxy.endpoint);
    clients.push(client);
    await next(client, "open");
    return client;
  };
  let sequence = 0;
  const request = async (
    client: NodeWs.WebSocket,
    method: string,
    params?: object,
    sessionId?: string,
  ) => {
    const response = next(client, "message");
    client.send(
      JSON.stringify({
        id: ++sequence,
        method,
        ...(params ? { params } : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    );
    const [data] = await response;
    return JSON.parse(String(data)) as {
      result?: { targetInfos: { targetId: string }[] };
      error?: { message: string };
    };
  };
  return {
    proxy,
    connect,
    request,
    received,
    close: async () => {
      clients.forEach((client) => client.terminate());
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
};

it("filters target discovery and permits only this tab's attached CDP sessions", async () => {
  const f = await fixture();
  try {
    f.proxy.activate();
    const client = await f.connect();
    expect((await f.request(client, "Target.getTargets")).result?.targetInfos).toEqual([
      { targetId: "ours" },
    ]);
    expect(
      (await f.request(client, "Target.attachToTarget", { targetId: "other" })).error,
    ).toBeDefined();
    await f.request(client, "Target.attachToTarget", { targetId: "ours", flatten: true });
    expect((await f.request(client, "Runtime.evaluate", {}, "other-session")).error).toBeDefined();
    expect((await f.request(client, "Runtime.evaluate", {}, "our-session")).error).toBeUndefined();
    expect(
      (await f.request(client, "Target.createTarget", { url: "about:blank" })).error,
    ).toBeDefined();
    expect(f.received).toEqual(["Target.getTargets", "Target.attachToTarget", "Runtime.evaluate"]);
  } finally {
    await f.close();
  }
});

it("retains CDP connections across commands while denying daemon work after return", async () => {
  const f = await fixture();
  try {
    f.proxy.activate();
    const client = await f.connect();
    await f.request(client, "Target.attachToTarget", { targetId: "ours" });
    f.proxy.deactivate();
    expect(
      (await f.request(client, "Runtime.evaluate", {}, "our-session")).error?.message,
    ).toContain("inactive");
    f.proxy.activate();
    expect((await f.request(client, "Runtime.evaluate", {}, "our-session")).error).toBeUndefined();
    const closed = next(client, "close");
    f.proxy.disconnect();
    await closed;
    const rejected = await f.connect();
    const [code] = await next(rejected, "close");
    expect(code).toBe(1008);
    expect(f.received).toEqual(["Target.attachToTarget", "Runtime.evaluate"]);
  } finally {
    await f.close();
  }
});
