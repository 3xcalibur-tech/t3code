// @effect-diagnostics nodeBuiltinImport:off - A loopback CDP bridge guards the external CLI at the browser boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeWs from "ws";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";

const Message = Schema.Struct({
  id: Schema.optional(Schema.Finite),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  result: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  sessionId: Schema.optional(Schema.String),
});
const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(Message));

/** Established CDP sessions retain their element refs between authorized CLI commands. */
export async function createAgentBrowserCdpProxy(input: { upstream: string; targetId: string }) {
  const path = `/${NodeCrypto.randomUUID()}`;
  const server = new NodeWs.WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path,
    maxPayload: 1_000_000,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The browser command bridge did not bind a loopback port.");
  const pairs = new Set<{ client: NodeWs.WebSocket; upstream: NodeWs.WebSocket }>();
  let enabled = false;

  server.on("connection", (client) => {
    if (!enabled) {
      client.close(1008, "Agent browser control is inactive.");
      return;
    }
    const upstream = new NodeWs.WebSocket(input.upstream, { maxPayload: 4 * 1024 * 1024 });
    const pair = { client, upstream };
    pairs.add(pair);
    const pending: string[] = [];
    const methods = new Map<number, string>();
    const sessions = new Set<string>();
    const disconnect = () => {
      pairs.delete(pair);
      client.terminate();
      upstream.terminate();
    };
    const send = (message: string) => {
      if (client.readyState !== NodeWs.WebSocket.OPEN) return;
      if (client.bufferedAmount > 4 * 1024 * 1024) {
        disconnect();
        return;
      }
      client.send(message);
    };
    const error = (id: number, message: string, sessionId?: string) =>
      send(
        JSON.stringify({
          id,
          ...(sessionId ? { sessionId } : {}),
          error: { code: -32000, message },
        }),
      );
    client.on("error", disconnect);
    upstream.on("error", disconnect);
    client.on("close", disconnect);
    upstream.on("close", disconnect);
    upstream.on("open", () => {
      if (!enabled) {
        disconnect();
        return;
      }
      for (const message of pending) upstream.send(message);
      pending.length = 0;
    });
    client.on("message", (data) => {
      let packet: typeof Message.Type;
      try {
        packet = decodeMessage(data.toString());
      } catch {
        client.close(1003, "Invalid CDP command.");
        return;
      }
      if (packet.id === undefined || packet.method === undefined) return;
      const id = packet.id;
      const method = packet.method;
      if (!enabled) {
        error(packet.id, "Agent browser control is inactive.", packet.sessionId);
        return;
      }
      if (packet.sessionId && !sessions.has(packet.sessionId)) {
        error(packet.id, "The CDP session is outside this browser tab.", packet.sessionId);
        return;
      }
      const targetId = packet.params?.targetId;
      if (targetId !== undefined && targetId !== input.targetId) {
        error(packet.id, "The CDP target is outside this browser tab.", packet.sessionId);
        return;
      }
      if (
        [
          "Browser.close",
          "Target.createTarget",
          "Target.closeTarget",
          "Target.disposeBrowserContext",
          "Target.createBrowserContext",
        ].includes(packet.method)
      ) {
        error(packet.id, "T3 owns browser tabs and their lifecycle.", packet.sessionId);
        return;
      }
      if (
        packet.method === "Target.setDiscoverTargets" ||
        (packet.method === "Target.setAutoAttach" && !packet.sessionId)
      ) {
        send(JSON.stringify({ id: packet.id, result: {} }));
        return;
      }
      if (packet.method === "Target.getTargetInfo" && !packet.sessionId)
        packet = { ...packet, params: { ...packet.params, targetId: input.targetId } };
      methods.set(id, method);
      const message = JSON.stringify(packet);
      if (upstream.readyState === NodeWs.WebSocket.OPEN) upstream.send(message);
      else if (upstream.readyState === NodeWs.WebSocket.CONNECTING && pending.length < 32)
        pending.push(message);
      else disconnect();
    });
    upstream.on("message", (data) => {
      const message = data.toString();
      let packet: typeof Message.Type;
      try {
        packet = decodeMessage(message);
      } catch {
        disconnect();
        return;
      }
      if (packet.id !== undefined) {
        const method = methods.get(packet.id);
        methods.delete(packet.id);
        if (method === "Target.attachToTarget" && typeof packet.result?.sessionId === "string")
          sessions.add(packet.result.sessionId);
        if (method === "Target.getTargets" && Array.isArray(packet.result?.targetInfos)) {
          const targetInfos = packet.result.targetInfos.filter(
            (target) =>
              Predicate.isObject(target) &&
              "targetId" in target &&
              target.targetId === input.targetId,
          );
          send(JSON.stringify({ ...packet, result: { ...packet.result, targetInfos } }));
          return;
        }
      }
      if (
        packet.method === "Target.attachedToTarget" &&
        typeof packet.params?.sessionId === "string"
      ) {
        if (!packet.sessionId || !sessions.has(packet.sessionId)) return;
        sessions.add(packet.params.sessionId);
      }
      // Responses and events already in flight may arrive after a successful
      // command returns. They carry no new authority and preserve daemon state.
      send(message);
    });
  });

  return {
    endpoint: `ws://127.0.0.1:${address.port}${path}`,
    activate() {
      enabled = true;
    },
    deactivate() {
      enabled = false;
    },
    disconnect() {
      enabled = false;
      for (const pair of pairs) {
        pair.client.terminate();
        pair.upstream.terminate();
      }
      pairs.clear();
    },
    async close() {
      enabled = false;
      for (const pair of pairs) {
        pair.client.terminate();
        pair.upstream.terminate();
      }
      pairs.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type AgentBrowserCdpProxy = Awaited<ReturnType<typeof createAgentBrowserCdpProxy>>;
