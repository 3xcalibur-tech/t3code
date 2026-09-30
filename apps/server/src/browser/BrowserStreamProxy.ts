import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  ThreadId,
  PreviewBrowserClientMessage,
  PreviewBrowserRuntimeError,
  type PreviewBrowserServerMessage,
} from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as BrowserRuntime from "./BrowserRuntime.ts";

const decodePacket = Schema.decodeUnknownEffect(Schema.fromJsonString(PreviewBrowserClientMessage));
export const browserPacketNeedsOperate = (packet: PreviewBrowserClientMessage) =>
  packet.type !== "ack" && packet.type !== "config";

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (
    Option.isNone(url) ||
    request.method !== "GET" ||
    request.headers.upgrade?.toLowerCase() !== "websocket"
  ) {
    return HttpServerResponse.empty({ status: 404 });
  }
  const match = /^\/api\/browser\/([^/]+)\/([^/]+)\/ws$/.exec(url.value.pathname);
  if (!match) return HttpServerResponse.empty({ status: 404 });
  const path = yield* Effect.try(() => ({
    threadId: decodeURIComponent(match[1]!),
    tabId: decodeURIComponent(match[2]!),
  })).pipe(Effect.option);
  if (Option.isNone(path)) return HttpServerResponse.empty({ status: 400 });
  const { threadId, tabId } = path.value;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateWebSocketUpgrade(request).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (EnvironmentAuth.isServerAuthCredentialError(error)) {
          return yield* failEnvironmentAuthInvalid(
            EnvironmentAuth.serverAuthCredentialReason(error),
            EnvironmentAuth.serverAuthDpopFailureReason(error),
          );
        }
        return yield* failEnvironmentInternal("internal_error", error);
      }),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationReadScope))
    return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  const canOperate = session.scopes.includes(AuthOrchestrationOperateScope);
  const manager = yield* PreviewManager.PreviewManager;
  const runtimeOption = yield* Effect.serviceOption(BrowserRuntime.BrowserRuntime);
  const runtime = Option.getOrUndefined(runtimeOption);
  const nativeUrl = manager.browserStreamUrl(threadId, tabId);
  if (!runtime?.has(threadId, tabId) && !nativeUrl)
    return HttpServerResponse.empty({ status: 404 });

  const socket = yield* request.upgrade;
  const write = yield* socket.writer;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const send = (message: PreviewBrowserServerMessage) => write(JSON.stringify(message));
  const parse = Effect.fn("BrowserStreamProxy.parse")(function* (data: string | Uint8Array) {
    if ((typeof data === "string" ? data.length : data.byteLength) > 128 * 1024) {
      return yield* new PreviewBrowserRuntimeError({
        threadId,
        tabId,
        message: "The browser input message is too large.",
      });
    }
    return yield* decodePacket(typeof data === "string" ? data : new TextDecoder().decode(data));
  });

  yield* Effect.scoped(
    Effect.gen(function* () {
      if (runtime?.has(threadId, tabId)) {
        const viewer = yield* Effect.acquireRelease(
          runtime.attach(threadId, tabId, (message) => {
            runFork(send(message).pipe(Effect.catchCause(() => Effect.void)));
          }),
          (connection) => connection.close,
        );
        yield* socket.runRaw((data) =>
          parse(data).pipe(
            Effect.flatMap((packet) =>
              Effect.gen(function* () {
                if (browserPacketNeedsOperate(packet) && !canOperate)
                  return yield* send({
                    type: "error",
                    message: "This connection has read-only access to the browser.",
                  });
                return yield* viewer.message(packet);
              }),
            ),
            Effect.catch((error) => send({ type: "error", message: error.message })),
          ),
        );
      } else if (nativeUrl) {
        // The native bridge is loopback-only and already scoped to this guest. Its
        // own WebSocket lifetime controls takeover; T3 authenticates before forwarding.
        const upstream = yield* Socket.makeWebSocket(nativeUrl, { openTimeout: "10 seconds" }).pipe(
          Effect.provide(NodeSocket.layerWebSocketConstructor),
        );
        const forward = yield* upstream.writer;
        yield* Effect.raceFirst(
          upstream.runRaw((data) => write(data)),
          socket.runRaw((data) =>
            parse(data).pipe(
              Effect.flatMap((packet) =>
                browserPacketNeedsOperate(packet) && !canOperate
                  ? send({
                      type: "error",
                      message: "This connection has read-only access to the browser.",
                    })
                  : forward(JSON.stringify(packet)).pipe(
                      Effect.tap(() =>
                        packet.type === "set_viewport"
                          ? manager
                              .resize({
                                threadId: ThreadId.make(threadId),
                                tabId,
                                viewport: packet.viewport,
                              })
                              .pipe(Effect.asVoid)
                          : Effect.void,
                      ),
                    ),
              ),
              Effect.catch((error) => send({ type: "error", message: error.message })),
            ),
          ),
        );
      }
    }),
  ).pipe(Effect.catchCause(() => Effect.void));
  return HttpServerResponse.empty();
});

export const browserStreamProxyRouteLayer = HttpRouter.add(
  "GET",
  `${BrowserRuntime.BROWSER_ROUTE_PREFIX}/*`,
  handler,
);
