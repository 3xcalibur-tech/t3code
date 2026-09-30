// @effect-diagnostics nodeBuiltinImport:off - Fake subprocesses exercise the browser ownership boundary without launching Chrome.
import * as NodeEvents from "node:events";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import {
  ThreadId,
  type PreviewSessionSnapshot,
  type PreviewBrowserServerMessage,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as BrowserRuntime from "./BrowserRuntime.ts";
import { createAgentBrowserCdpProxy } from "./AgentBrowserCdpProxy.ts";
import { ensureBrowserToolchain } from "./BrowserToolchain.ts";
import { runAgentBrowser } from "@t3tools/shared/agentBrowserRuntime";
import * as NodeChildProcess from "node:child_process";

vi.mock("./AgentBrowserCdpProxy.ts", () => ({
  createAgentBrowserCdpProxy: vi.fn(async () => ({
    endpoint: "ws://fake-cdp-guard",
    activate: vi.fn(),
    deactivate: vi.fn(),
    disconnect: vi.fn(),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("./BrowserToolchain.ts", () => ({ ensureBrowserToolchain: vi.fn() }));
vi.mock("@t3tools/shared/agentBrowserRuntime", () => ({
  runAgentBrowser: vi.fn(),
  closeAgentBrowserSession: vi.fn(async () => undefined),
}));

const metadata: PreviewSessionSnapshot = {
  threadId: "browser-test-thread",
  tabId: "browser-test-tab",
  runtime: "server",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  viewport: { _tag: "fill" },
  updatedAt: "2026-09-14T00:00:00.000Z",
};

const fixture = () => {
  vi.clearAllMocks();
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stderr: new NodeEvents.EventEmitter(),
    exitCode: null as number | null,
    kill: vi.fn(() => {
      child.exitCode = 0;
      child.emit("exit", 0);
      return true;
    }),
  });
  vi.mocked(NodeChildProcess.spawn).mockImplementation(() => {
    queueMicrotask(() =>
      child.stderr.emit(
        "data",
        Buffer.from("DevTools listening on ws://127.0.0.1:4444/devtools/browser/test\n"),
      ),
    );
    return child as unknown as ReturnType<typeof NodeChildProcess.spawn>;
  });
  const page = Object.assign(new NodeEvents.EventEmitter(), {
    closed: false,
    isClosed: () => page.closed,
    close: vi.fn(async () => {
      page.closed = true;
    }),
    title: async () => "Test page",
    url: () => "about:blank",
    evaluate: async () => false,
    viewportSize: () => ({ width: 1280, height: 800 }),
    setViewportSize: vi.fn(async () => undefined),
    emulateMedia: vi.fn(async () => undefined),
    goto: vi.fn(async () => undefined),
    mainFrame: () => undefined,
    screencast: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
  });
  const cdp = {
    send: vi.fn(async (method: string) =>
      method === "Target.getTargetInfo"
        ? { targetInfo: { targetId: "target-test" } }
        : { currentIndex: 0, entries: [] },
    ),
  };
  const context = { pages: () => [], newPage: async () => page, newCDPSession: async () => cdp };
  const browser = { contexts: () => [context], close: vi.fn(async () => undefined) };
  const toolchain = {
    executablePath: "/fake/chromium",
    playwright: {
      chromium: { connectOverCDP: async () => browser },
    } as unknown as typeof import("playwright-core"),
  };
  vi.mocked(ensureBrowserToolchain).mockReturnValue(
    Effect.succeed(toolchain) as unknown as ReturnType<typeof ensureBrowserToolchain>,
  );
  vi.mocked(runAgentBrowser).mockResolvedValue({ stdout: "snapshot", stderr: "", exitCode: 0 });
  return { child, page, browser, toolchain };
};

const makeRuntime = BrowserRuntime.make.pipe(
  Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-browser-runtime-test-" })),
  Effect.provideService(ProcessRunner.ProcessRunner, {
    run: () => Effect.die("The mocked toolchain never runs an installer"),
  }),
  Effect.provide(NodeServices.layer),
);

it.effect("viewer viewport choices reach the browser and stay in its reported session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { page } = fixture();
      const runtime = yield* makeRuntime;
      const reports: import("@t3tools/contracts").PreviewReportStatusInput[] = [];
      yield* runtime.open(metadata, (report) => reports.push(report));
      const viewer = yield* runtime.attach(metadata.threadId, metadata.tabId, () => undefined);
      const fixed = { _tag: "freeform" as const, width: 390, height: 844 };
      const denied = yield* Effect.result(
        viewer.message({ type: "set_viewport", viewport: fixed }),
      );
      expect(Result.isFailure(denied)).toBe(true);
      yield* viewer.message({ type: "take_control" });
      yield* viewer.message({ type: "set_viewport", viewport: fixed });
      expect(page.setViewportSize).toHaveBeenLastCalledWith({ width: 390, height: 844 });
      expect(reports.at(-1)?.viewport).toEqual(fixed);
      yield* viewer.message({ type: "set_color_scheme", colorScheme: "dark" });
      expect(page.emulateMedia).toHaveBeenLastCalledWith({ colorScheme: "dark" });
      yield* viewer.message({
        type: "set_viewport",
        viewport: { _tag: "fill" },
        width: 600,
        height: 900,
      });
      expect(page.setViewportSize).toHaveBeenLastCalledWith({ width: 600, height: 900 });
      expect(reports.at(-1)?.viewport).toEqual({ _tag: "fill" });
    }),
  ),
);

it.effect("closing during the runtime install prevents an orphan Chrome process", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = fixture();
      const started = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      vi.mocked(ensureBrowserToolchain).mockReturnValue(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(ready);
          return fake.toolchain;
        }) as unknown as ReturnType<typeof ensureBrowserToolchain>,
      );
      const runtime = yield* makeRuntime;
      const opening = yield* runtime.open(metadata, () => undefined).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* runtime.close(metadata.threadId, metadata.tabId);
      yield* Deferred.succeed(ready, undefined);
      const result = yield* Effect.result(Fiber.join(opening));
      expect(Result.isFailure(result)).toBe(true);
      expect(NodeChildProcess.spawn).not.toHaveBeenCalled();
      expect(runtime.has(metadata.threadId, metadata.tabId)).toBe(false);
    }),
  ),
);

it.effect("initial navigation failure closes the created tab and captured browser process", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = fixture();
      fake.page.goto.mockRejectedValue(new Error("Navigation failed"));
      const runtime = yield* makeRuntime;
      const result = yield* Effect.result(
        runtime.open(
          { ...metadata, navStatus: { _tag: "Loading", url: "http://localhost:5173", title: "" } },
          () => undefined,
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(runtime.has(metadata.threadId, metadata.tabId)).toBe(false);
      expect(fake.page.close).toHaveBeenCalled();
      expect(fake.child.kill).toHaveBeenCalled();
    }),
  ),
);

it.effect("failed stream startup removes the viewer and preserves the browser session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = fixture();
      fake.page.screencast.start.mockRejectedValue(new Error("Capture unavailable"));
      const runtime = yield* makeRuntime;
      yield* runtime.open(metadata, () => undefined);
      const result = yield* Effect.result(
        runtime.attach(metadata.threadId, metadata.tabId, () => undefined),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(runtime.has(metadata.threadId, metadata.tabId)).toBe(true);
      const status = yield* runtime.invoke(metadata.threadId, metadata.tabId, "status", {}, 1000);
      expect(status).toMatchObject({ visible: false, humanControl: false });
    }),
  ),
);

it.effect(
  "takeover blocks CLI actions, and returning control requires fresh element references",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        fixture();
        const runtime = yield* makeRuntime;
        const messages: PreviewBrowserServerMessage[] = [];
        yield* runtime.open(metadata, () => undefined);
        const viewer = yield* runtime.attach(metadata.threadId, metadata.tabId, (message) =>
          messages.push(message),
        );
        yield* viewer.message({ type: "take_control" });
        const blocked = yield* Effect.result(
          runtime.invoke(
            metadata.threadId,
            metadata.tabId,
            "agentBrowser",
            { args: ["click", "@e1"] },
            1000,
          ),
        );
        expect(Result.isFailure(blocked)).toBe(true);
        expect(runAgentBrowser).not.toHaveBeenCalled();
        expect(
          yield* runtime.invoke(metadata.threadId, metadata.tabId, "status", {}, 1000),
        ).toMatchObject({ humanControl: true });
        yield* viewer.message({ type: "release_control" });
        const stale = yield* Effect.result(
          runtime.invoke(
            metadata.threadId,
            metadata.tabId,
            "agentBrowser",
            { args: ["click", "@e1"] },
            1000,
          ),
        );
        expect(Result.isFailure(stale)).toBe(true);
        yield* runtime.invoke(
          metadata.threadId,
          metadata.tabId,
          "agentBrowser",
          { args: ["--json", "snapshot", "-i"] },
          1000,
        );
        yield* runtime.invoke(
          metadata.threadId,
          metadata.tabId,
          "agentBrowser",
          { args: ["click", "@e1"] },
          1000,
        );
        expect(runAgentBrowser).toHaveBeenCalledTimes(2);
        expect(
          messages.some(
            (message) => message.type === "control" && message.controller === viewer.id,
          ),
        ).toBe(true);
        yield* viewer.close;
        expect(runtime.has(metadata.threadId, metadata.tabId)).toBe(true);
        yield* runtime.close(ThreadId.make(metadata.threadId), metadata.tabId);
        expect(runtime.has(metadata.threadId, metadata.tabId)).toBe(false);
      }),
    ),
);

it.effect("interrupting a managed command disconnects its CDP authority before takeover", () =>
  Effect.scoped(
    Effect.gen(function* () {
      fixture();
      const started = yield* Deferred.make<void>();
      vi.mocked(runAgentBrowser).mockImplementation(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            Deferred.doneUnsafe(started, Effect.void);
          }),
      );
      const runtime = yield* makeRuntime;
      yield* runtime.open(metadata, () => undefined);
      const viewer = yield* runtime.attach(metadata.threadId, metadata.tabId, () => undefined);
      const command = yield* runtime
        .invoke(
          metadata.threadId,
          metadata.tabId,
          "agentBrowser",
          { args: ["snapshot", "-i"] },
          10000,
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      const takeover = yield* viewer.message({ type: "take_control" }).pipe(Effect.forkScoped);
      yield* Fiber.interrupt(command);
      yield* Fiber.join(takeover);
      const proxy = yield* Effect.promise(
        async () =>
          (await vi.mocked(createAgentBrowserCdpProxy).mock.results[0]!.value) as Awaited<
            ReturnType<typeof createAgentBrowserCdpProxy>
          >,
      );
      expect(proxy.disconnect).toHaveBeenCalled();
      expect(
        yield* runtime.invoke(metadata.threadId, metadata.tabId, "status", {}, 1000),
      ).toMatchObject({ humanControl: true });
    }),
  ),
);

it.effect("human takeover interrupts a running CLI and awaits its shutdown receipt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      fixture();
      const started = yield* Deferred.make<void>();
      const aborted = yield* Deferred.make<void>();
      let finishShutdown!: () => void;
      const shutdown = new Promise<void>((resolve) => {
        finishShutdown = resolve;
      });
      vi.mocked(runAgentBrowser).mockImplementation(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                Deferred.doneUnsafe(aborted, Effect.void);
                void shutdown.then(() => reject(signal.reason));
              },
              { once: true },
            );
            Deferred.doneUnsafe(started, Effect.void);
          }),
      );
      const runtime = yield* makeRuntime;
      yield* runtime.open(metadata, () => undefined);
      const viewer = yield* runtime.attach(metadata.threadId, metadata.tabId, () => undefined);
      const command = yield* runtime
        .invoke(
          metadata.threadId,
          metadata.tabId,
          "agentBrowser",
          { args: ["wait", "60000"] },
          60000,
        )
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(started);
      const queued = yield* runtime
        .invoke(
          metadata.threadId,
          metadata.tabId,
          "agentBrowser",
          { args: ["snapshot", "-i"] },
          10000,
        )
        .pipe(Effect.result, Effect.forkScoped);
      const takeover = yield* viewer.message({ type: "take_control" }).pipe(Effect.forkScoped);
      yield* Deferred.await(aborted);
      const proxy = yield* Effect.promise(
        async () =>
          (await vi.mocked(createAgentBrowserCdpProxy).mock.results[0]!.value) as Awaited<
            ReturnType<typeof createAgentBrowserCdpProxy>
          >,
      );
      expect(proxy.disconnect).toHaveBeenCalled();
      expect(
        yield* runtime.invoke(metadata.threadId, metadata.tabId, "status", {}, 1000),
      ).toMatchObject({ humanControl: false });
      finishShutdown();
      yield* Fiber.join(takeover);
      const interrupted = yield* Fiber.join(command);
      const canceledQueued = yield* Fiber.join(queued);
      expect(Result.isFailure(interrupted)).toBe(true);
      expect(Result.isFailure(canceledQueued)).toBe(true);
      expect(runAgentBrowser).toHaveBeenCalledTimes(1);
      expect(
        yield* runtime.invoke(metadata.threadId, metadata.tabId, "status", {}, 1000),
      ).toMatchObject({ humanControl: true });
    }),
  ),
);
