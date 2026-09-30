// @effect-diagnostics nodeBuiltinImport:off - Browser subprocess and installed tooling live at the runtime boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";
import {
  PreviewBrowserRuntimeError,
  ThreadId,
  type PreviewBrowserClientMessage,
  type PreviewBrowserServerMessage,
  type PreviewAutomationOperation,
  type PreviewAutomationStatus,
  type PreviewAutomationSnapshot,
  type PreviewReportStatusInput,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationClickInput,
  type PreviewAutomationTypeInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationWaitForInput,
  type PreviewAutomationResizeInput,
  type PreviewAutomationSetColorSchemeInput,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import {
  agentBrowserCommandError,
  getAgentBrowserCommandName,
} from "@t3tools/shared/agentBrowserCommand";
import { runAgentBrowser, closeAgentBrowserSession } from "@t3tools/shared/agentBrowserRuntime";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { createPendingAttachmentId } from "../attachmentStore.ts";
import { ensureBrowserToolchain } from "./BrowserToolchain.ts";
import {
  BrowserControlInterrupted,
  BrowserFramePacer,
  LatestBrowserFrame,
  SessionControl,
} from "./SessionControl.ts";
import { BrowserLifecycle } from "./BrowserLifecycle.ts";
import { createAgentBrowserCdpProxy, type AgentBrowserCdpProxy } from "./AgentBrowserCdpProxy.ts";

export const BROWSER_ROUTE_PREFIX = "/api/browser";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const key = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;
const digest = (id: string) =>
  NodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 32);
const failure = (threadId: string, tabId?: string) => (cause: unknown) =>
  new PreviewBrowserRuntimeError({
    threadId,
    ...(tabId === undefined ? {} : { tabId }),
    message: cause instanceof Error ? cause.message : "The browser operation failed.",
    cause,
  });

type Frame = Extract<PreviewBrowserServerMessage, { type: "frame" }>;
type ReportStatus = (status: PreviewReportStatusInput) => void;
interface Viewer {
  readonly id: string;
  readonly send: (message: PreviewBrowserServerMessage) => void;
  readonly frames: LatestBrowserFrame<Frame>;
  maxFps: number;
  pacer: BrowserFramePacer<Frame>;
}
interface BrowserHost {
  readonly process: NodeChildProcess.ChildProcess;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly cdp: string;
  readonly profileKey: string;
  readonly tabs: Set<string>;
}
interface BrowserTab {
  readonly threadId: string;
  readonly tabId: string;
  readonly host: BrowserHost;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly targetId: string;
  readonly control: SessionControl;
  readonly viewers: Map<string, Viewer>;
  readonly report: ReportStatus;
  readonly consoleEntries: Array<PreviewAutomationSnapshot["consoleEntries"][number]>;
  readonly networkEntries: Array<PreviewAutomationSnapshot["networkEntries"][number]>;
  readonly actions: Array<PreviewAutomationSnapshot["actionTimeline"][number]>;
  viewport: PreviewViewportSetting;
  frame: Frame | null;
  sequence: number;
  capture: Promise<void>;
  capturing: boolean;
  captureRecordingPath: string | null;
  agentBrowserUsed: boolean;
  agentReferencesStale: boolean;
  agentCdpProxy: AgentBrowserCdpProxy | null;
  agentCommandController: AbortController | null;
  closed: boolean;
  recording: { path: string; attachmentId: string; startedAt: string } | null;
}

export interface BrowserViewerConnection {
  readonly id: string;
  readonly message: (
    message: PreviewBrowserClientMessage,
  ) => Effect.Effect<void, PreviewBrowserRuntimeError>;
  readonly close: Effect.Effect<void>;
}

export class BrowserRuntime extends Context.Service<
  BrowserRuntime,
  {
    readonly open: (
      snapshot: PreviewSessionSnapshot,
      report: ReportStatus,
      isCurrent?: () => boolean,
    ) => Effect.Effect<void, PreviewBrowserRuntimeError>;
    readonly has: (threadId: string, tabId: string) => boolean;
    readonly invoke: (
      threadId: string,
      tabId: string,
      operation: PreviewAutomationOperation,
      input: unknown,
      timeoutMs: number,
    ) => Effect.Effect<unknown, PreviewBrowserRuntimeError>;
    readonly navigate: (
      threadId: string,
      tabId: string,
      url: string,
    ) => Effect.Effect<void, PreviewBrowserRuntimeError>;
    readonly resize: (
      threadId: string,
      tabId: string,
      viewport: PreviewViewportSetting,
    ) => Effect.Effect<void, PreviewBrowserRuntimeError>;
    readonly refresh: (
      threadId: string,
      tabId: string,
    ) => Effect.Effect<void, PreviewBrowserRuntimeError>;
    readonly close: (
      threadId: string,
      tabId?: string,
    ) => Effect.Effect<void, PreviewBrowserRuntimeError>;
    readonly attach: (
      threadId: string,
      tabId: string,
      send: (message: PreviewBrowserServerMessage) => void,
    ) => Effect.Effect<BrowserViewerConnection, PreviewBrowserRuntimeError>;
  }
>()("t3/browser/BrowserRuntime") {}

const dimensions = (setting: PreviewViewportSetting) =>
  setting._tag === "fill" ? DEFAULT_VIEWPORT : { width: setting.width, height: setting.height };

const launchChrome = (
  executable: string,
  profile: string,
): Promise<{ child: NodeChildProcess.ChildProcess; cdp: string }> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      executable,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    let stderr = "";
    let settled = false;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;

      child.kill();
      reject(cause);
    };
    AbortSignal.timeout(30000).addEventListener(
      "abort",
      () =>
        fail(
          new Error(
            "Chromium did not start within 30 seconds. Check that its operating-system dependencies are installed.",
          ),
        ),
      { once: true },
    );
    child.once("error", fail);
    child.once("exit", (code) =>
      fail(new Error(`Chromium exited before it was ready (${code}). ${stderr.slice(-2000)}`)),
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
      const endpoint =
        /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(
          stderr,
        )?.[1];
      if (endpoint && !settled) {
        settled = true;

        resolve({ child, cdp: endpoint });
      }
    });
  });

const CaptureResult = Schema.Struct({ data: Schema.String });
const TargetResult = Schema.Struct({ targetInfo: Schema.Struct({ targetId: Schema.String }) });
const decodeCapture = Schema.decodeUnknownSync(CaptureResult);
const decodeTarget = Schema.decodeUnknownSync(TargetResult);
const decodeAgentArguments = Schema.decodeUnknownSync(
  Schema.Struct({ args: Schema.Array(Schema.String) }),
);

/** Sessions outlive viewers; the server scope owns every launched Chrome process. */
export const make = Effect.gen(function* BrowserRuntimeMake() {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const scope = yield* Scope.Scope;
  const clock = yield* Clock.Clock;
  const timestamp = () => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
  const toolchainEffect = ensureBrowserToolchain(config.baseDir).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
  );
  const tabs = new Map<string, BrowserTab>();
  const profiles = new Map<string, Promise<BrowserHost>>();
  const hostPromises = new WeakMap<BrowserHost, Promise<BrowserHost>>();
  const lifecycle = new BrowserLifecycle();
  let shuttingDown = false;
  const artifactDir = config.attachmentsDir;

  const shutdownHost = async (host: BrowserHost) => {
    await host.browser.close().catch(() => undefined);
    // The CDP connection may have closed without closing the externally launched browser.
    if (host.process.exitCode === null) host.process.kill();
    if (profiles.get(host.profileKey) === hostPromises.get(host)) profiles.delete(host.profileKey);
  };
  yield* Scope.addFinalizer(
    scope,
    Effect.promise(async () => {
      shuttingDown = true;
      lifecycle.cancel();
      await Promise.allSettled(
        [...tabs.values()].map(async (tab) => {
          tab.closed = true;
          for (const viewer of tab.viewers.values()) viewer.pacer.close();
          if (tab.agentCdpProxy) await tab.agentCdpProxy.close();
          if (tab.agentBrowserUsed)
            await closeAgentBrowserSession({
              directory: NodePath.join(config.baseDir, "tools", "agent-browser"),
              session: `t3-${digest(key(tab.threadId, tab.tabId))}`,
            }).catch(() => undefined);
          for (const viewer of tab.viewers.values())
            viewer.send({ type: "error", message: "The environment is stopping." });
          await tab.page.close();
        }),
      );
      await Promise.allSettled(
        [...profiles.values()].map(async (host) => shutdownHost(await host)),
      );
      tabs.clear();
    }),
  );

  const get = (threadId: string, tabId: string) => {
    const tab = tabs.get(key(threadId, tabId));
    if (!tab || tab.closed || tab.page.isClosed())
      throw new Error("This browser tab is no longer running. Open another browser tab.");
    return tab;
  };

  const disposeTab = async (tab: BrowserTab) => {
    const id = key(tab.threadId, tab.tabId);
    tab.closed = true;
    for (const viewer of tab.viewers.values()) viewer.pacer.close();
    tabs.delete(id);
    tab.host.tabs.delete(id);
    if (tab.agentCdpProxy) await tab.agentCdpProxy.close();
    if (tab.agentBrowserUsed)
      await closeAgentBrowserSession({
        directory: NodePath.join(config.baseDir, "tools", "agent-browser"),
        session: `t3-${digest(id)}`,
      }).catch(() => undefined);
    for (const viewer of tab.viewers.values())
      viewer.send({ type: "error", message: "This browser tab was closed." });
    await tab.page.close().catch(() => undefined);
    if (tab.host.tabs.size === 0 && !lifecycle.hasPendingProfile(tab.host.profileKey))
      await shutdownHost(tab.host);
  };

  const broadcastControl = (tab: BrowserTab) => {
    for (const viewer of tab.viewers.values())
      viewer.send({ type: "control", viewerId: viewer.id, controller: tab.control.controller });
  };

  const publishStatus = async (tab: BrowserTab) => {
    if (tab.closed || tab.page.isClosed()) return;
    const title = await tab.page.title().catch(() => "");
    const loading = await tab.page
      .evaluate<boolean>('document.readyState !== "complete"')
      .catch(() => false);
    const history = await tab.cdp
      .send("Page.getNavigationHistory")
      .catch(() => ({ currentIndex: 0, entries: [] }));
    const historyIndex = typeof history.currentIndex === "number" ? history.currentIndex : 0;
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const viewport = tab.page.viewportSize() ?? dimensions(tab.viewport);
    tab.report({
      threadId: ThreadId.make(tab.threadId),
      tabId: tab.tabId,
      navStatus: { _tag: loading ? "Loading" : "Success", url: tab.page.url(), title },
      canGoBack: historyIndex > 0,
      canGoForward: historyIndex < entries.length - 1,
      viewport: tab.viewport,
    });
    for (const viewer of tab.viewers.values()) {
      viewer.send({ type: "url", url: tab.page.url() });
      viewer.send({
        type: "status",
        connected: true,
        screencasting: tab.capturing,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        canGoBack: historyIndex > 0,
        canGoForward: historyIndex < entries.length - 1,
      });
    }
  };

  const updateCapture = (tab: BrowserTab) => {
    tab.capture = tab.capture
      .catch(() => undefined)
      .then(async () => {
        if (tab.closed) return;
        const wanted = tab.viewers.size > 0 || tab.recording !== null;
        const recordingPath = tab.recording?.path ?? null;
        if (tab.capturing && wanted && tab.captureRecordingPath === recordingPath) return;
        if (tab.capturing) await tab.page.screencast.stop();
        tab.capturing = false;
        if (tab.viewers.size === 0 && !tab.recording) return;
        await tab.page.screencast.start({
          size: { width: 1280, height: 800 },
          quality: 65,
          ...(tab.recording ? { path: tab.recording.path } : {}),
          onFrame: ({ data, viewportWidth, viewportHeight }) => {
            if (tab.closed) return;
            const frame: Frame = {
              type: "frame",
              seq: ++tab.sequence,
              data: data.toString("base64"),
              metadata: { deviceWidth: viewportWidth, deviceHeight: viewportHeight },
            };
            tab.frame = frame;
            for (const viewer of tab.viewers.values()) viewer.pacer.offer(frame);
          },
        });
        tab.capturing = true;
        tab.captureRecordingPath = recordingPath;
      });
    return tab.capture;
  };

  const snapshot = async (tab: BrowserTab): Promise<PreviewAutomationSnapshot> => {
    const page = await tab.page.evaluate<
      Pick<
        PreviewAutomationSnapshot,
        "url" | "title" | "loading" | "visibleText" | "interactiveElements"
      >
    >(String.raw`(() => {
      const elements = [...document.querySelectorAll("a[href],button,input,textarea,select,[role],[tabindex]")]
        .filter((element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"; })
        .slice(0, 80).map((element) => {
          const rect = element.getBoundingClientRect();
          const selector = element.id ? "#" + CSS.escape(element.id) : (() => {
            const parts = [];
            let node = element;
            while (node && parts.length < 8) {
              const parent = node.parentElement;
              const siblings = parent ? [...parent.children].filter((child) => child.tagName === node.tagName) : [];
              parts.unshift(node.tagName.toLowerCase() + (siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")" : ""));
              node = parent;
            }
            return parts.join(" > ");
          })();
          return { tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), name: (element.getAttribute("aria-label") || element.innerText || element.getAttribute("name") || "").slice(0, 160), selector,
            x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
      return { url: location.href, title: document.title, loading: document.readyState !== "complete", visibleText: (document.body?.innerText ?? "").slice(0, 12000), interactiveElements: elements };
    })()`);
    const viewport = tab.page.viewportSize() ?? dimensions(tab.viewport);
    const scale = Math.min(1, 1200 / viewport.width);
    const [image, accessibilityTree] = await Promise.all([
      tab.cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale },
      }),
      tab.page
        .locator("body")
        .ariaSnapshot()
        .catch(() => ""),
    ]);
    return {
      ...page,
      accessibilityTree: accessibilityTree.slice(0, 64000),
      consoleEntries: [...tab.consoleEntries],
      networkEntries: [...tab.networkEntries],
      actionTimeline: [...tab.actions],
      screenshot: {
        mimeType: "image/png",
        data: decodeCapture(image).data,
        width: Math.round(viewport.width * scale),
        height: Math.round(viewport.height * scale),
      },
    };
  };

  const open = Effect.fn("BrowserRuntime.open")(function* (
    metadata: PreviewSessionSnapshot,
    report: ReportStatus,
    isCurrent: () => boolean = () => true,
  ) {
    const profileKey = metadata.profileId ?? "default";
    const pending = lifecycle.start(metadata.threadId, metadata.tabId, profileKey);
    yield* Effect.gen(function* () {
      if (!isCurrent())
        return yield* new PreviewBrowserRuntimeError({
          threadId: metadata.threadId,
          tabId: metadata.tabId,
          message: "The browser tab was closed before it started.",
        });
      const toolchain = yield* toolchainEffect.pipe(
        Effect.mapError(failure(metadata.threadId, metadata.tabId)),
      );
      yield* Effect.tryPromise({
        try: async () => {
          if (shuttingDown) throw new Error("The environment is stopping.");
          pending.controller.signal.throwIfAborted();
          if (!isCurrent()) throw new Error("The browser tab was closed before it started.");
          let openedHost: BrowserHost | undefined;
          let openedPage: Page | undefined;
          let openedTab: BrowserTab | undefined;
          try {
            let hostPromise = profiles.get(profileKey);
            if (!hostPromise) {
              hostPromise = (async () => {
                const profile = NodePath.join(
                  config.stateDir,
                  "browser",
                  "profiles",
                  digest(profileKey),
                );
                await NodeFSP.mkdir(profile, { recursive: true });
                const launched = await launchChrome(toolchain.executablePath, profile);
                try {
                  const browser = await toolchain.playwright.chromium.connectOverCDP(launched.cdp);
                  const context = browser.contexts()[0];
                  if (!context) throw new Error("Chromium did not create a browser context.");
                  await Promise.all(context.pages().map((page) => page.close()));
                  const host: BrowserHost = {
                    process: launched.child,
                    browser,
                    context,
                    cdp: launched.cdp,
                    profileKey,
                    tabs: new Set(),
                  };
                  if (hostPromise) hostPromises.set(host, hostPromise);
                  launched.child.once("exit", () => {
                    if (profiles.get(profileKey) === hostPromises.get(host))
                      profiles.delete(profileKey);
                    for (const id of host.tabs) {
                      const tab = tabs.get(id);
                      if (!tab) continue;
                      tab.closed = true;
                      for (const viewer of tab.viewers.values()) viewer.pacer.close();
                      for (const viewer of tab.viewers.values())
                        viewer.send({
                          type: "error",
                          message: "Chromium stopped. Open another browser tab.",
                        });
                      tabs.delete(id);
                    }
                  });
                  return host;
                } catch (cause) {
                  launched.child.kill();
                  throw cause;
                }
              })();
              profiles.set(profileKey, hostPromise);
              hostPromise.catch(() => {
                if (profiles.get(profileKey) === hostPromise) profiles.delete(profileKey);
              });
            }
            const host = await hostPromise;
            openedHost = host;
            pending.controller.signal.throwIfAborted();
            if (!isCurrent()) throw new Error("The browser tab was closed before it started.");
            const page = await host.context.newPage();
            openedPage = page;
            const cdp = await host.context.newCDPSession(page);
            const targetId = decodeTarget(await cdp.send("Target.getTargetInfo")).targetInfo
              .targetId;
            const tab: BrowserTab = {
              threadId: metadata.threadId,
              tabId: metadata.tabId,
              host,
              page,
              cdp,
              targetId,
              control: new SessionControl(),
              viewers: new Map(),
              report,
              consoleEntries: [],
              networkEntries: [],
              actions: [],
              viewport: metadata.viewport ?? { _tag: "fill" },
              frame: null,
              sequence: 0,
              capture: Promise.resolve(),
              capturing: false,
              captureRecordingPath: null,
              agentBrowserUsed: false,
              agentReferencesStale: false,
              agentCdpProxy: null,
              agentCommandController: null,
              closed: false,
              recording: null,
            };
            openedTab = tab;
            pending.controller.signal.throwIfAborted();
            tabs.set(key(tab.threadId, tab.tabId), tab);
            host.tabs.add(key(tab.threadId, tab.tabId));
            page.on("console", (message) => {
              tab.consoleEntries.push({
                level: message.type(),
                text: message.text().slice(0, 2000),
                timestamp: timestamp(),
              });
              if (tab.consoleEntries.length > 50) tab.consoleEntries.shift();
            });
            page.on("requestfailed", (request) => {
              tab.networkEntries.push({
                url: request.url().slice(0, 2048),
                method: request.method(),
                status: null,
                failed: true,
                errorText: request.failure()?.errorText,
                timestamp: timestamp(),
              });
              if (tab.networkEntries.length > 50) tab.networkEntries.shift();
            });
            page.on("response", (response) => {
              if (response.status() < 400) return;
              tab.networkEntries.push({
                url: response.url().slice(0, 2048),
                method: response.request().method(),
                status: response.status(),
                failed: true,
                timestamp: timestamp(),
              });
              if (tab.networkEntries.length > 50) tab.networkEntries.shift();
            });
            page.on("framenavigated", (frame) => {
              if (frame === page.mainFrame()) void publishStatus(tab).catch(() => undefined);
            });
            page.on("load", () => {
              void publishStatus(tab).catch(() => undefined);
            });
            await page.setViewportSize(dimensions(tab.viewport));
            if (metadata.navStatus._tag !== "Idle")
              await page.goto(metadata.navStatus.url, {
                waitUntil: "domcontentloaded",
                timeout: 30000,
              });
            pending.controller.signal.throwIfAborted();
            await publishStatus(tab);
          } catch (cause) {
            pending.controller.abort();
            if (openedTab) await disposeTab(openedTab);
            else if (openedPage) await openedPage.close().catch(() => undefined);
            if (
              openedHost &&
              openedHost.tabs.size === 0 &&
              !lifecycle.hasPendingProfile(profileKey)
            )
              await shutdownHost(openedHost);
            throw cause;
          }
        },
        catch: failure(metadata.threadId, metadata.tabId),
      });
    }).pipe(Effect.ensuring(Effect.sync(() => lifecycle.finish(pending))));
  });

  const invoke = Effect.fn("BrowserRuntime.invoke")(function* (
    threadId: string,
    tabId: string,
    operation: PreviewAutomationOperation,
    input: unknown,
    timeoutMs: number,
  ) {
    return yield* Effect.tryPromise({
      try: async (operationSignal) => {
        const tab = get(threadId, tabId);
        if (operation === "status") {
          const viewport = tab.page.viewportSize() ?? dimensions(tab.viewport);
          const result: PreviewAutomationStatus = {
            available: true,
            visible: tab.viewers.size > 0,
            tabId,
            runtime: "server",
            humanControl: tab.control.controller !== null,
            url: tab.page.url(),
            title: await tab.page.title(),
            loading: await tab.page
              .evaluate<boolean>('document.readyState !== "complete"')
              .catch(() => false),
            viewportSetting: tab.viewport,
            viewport,
            agentBrowser: {
              command: "agent-browser",
              instructions:
                "Use agent-browser snapshot -i, then commands using its returned @refs. T3 manages this browser and profile. Use preview_open to create or select another tab.",
            },
          };
          return result;
        }
        return tab.control.agent(async () => {
          const action = {
            id: NodeCrypto.randomUUID(),
            action: operation,
            status: "running" as const,
            startedAt: timestamp(),
          };
          tab.actions.push(action);
          if (tab.actions.length > 30) tab.actions.shift();
          try {
            const result = await (async () => {
              switch (operation) {
                case "snapshot":
                  return snapshot(tab);
                case "open":
                  return { tabId };
                case "navigate": {
                  const data = input as PreviewAutomationNavigateInput;
                  const target = data.target;
                  const url = (() => {
                    if (target?.kind !== "environment-port")
                      return normalizePreviewUrl(
                        target?.kind === "url" ? target.url : (data.url ?? ""),
                      );
                    const origin = `${target.protocol ?? "http"}://localhost:${target.port}`;
                    const resolved = new URL(target.path ?? "/", origin);
                    if (resolved.origin !== origin)
                      throw new Error(
                        "An environment-port path must stay on the selected local server.",
                      );
                    return resolved.href;
                  })();
                  await tab.page.goto(url, {
                    timeout: timeoutMs,
                    waitUntil:
                      data.readiness === "none"
                        ? "commit"
                        : data.readiness === "domContentLoaded"
                          ? "domcontentloaded"
                          : "load",
                  });
                  return {
                    tabId,
                    url: tab.page.url(),
                    title: await tab.page.title(),
                    loading: false,
                  };
                }
                case "click": {
                  const data = input as PreviewAutomationClickInput;
                  if (data.locator ?? data.selector)
                    await tab.page
                      .locator((data.locator ?? data.selector)!)
                      .click({ timeout: timeoutMs });
                  else await tab.page.mouse.click(data.x!, data.y!);
                  return { tabId, clicked: true };
                }
                case "type": {
                  const data = input as PreviewAutomationTypeInput;
                  if (data.locator ?? data.selector) {
                    const locator = tab.page.locator((data.locator ?? data.selector)!);
                    if (data.clear) await locator.fill(data.text, { timeout: timeoutMs });
                    else {
                      await locator.focus({ timeout: timeoutMs });
                      await tab.page.keyboard.insertText(data.text);
                    }
                  } else {
                    if (data.clear) {
                      await tab.page.keyboard.press("ControlOrMeta+A");
                      await tab.page.keyboard.press("Backspace");
                    }
                    await tab.page.keyboard.insertText(data.text);
                  }
                  return { tabId, typed: true };
                }
                case "press": {
                  const data = input as PreviewAutomationPressInput;
                  await tab.page.keyboard.press([...(data.modifiers ?? []), data.key].join("+"));
                  return { tabId, pressed: true };
                }
                case "scroll": {
                  const data = input as PreviewAutomationScrollInput;
                  if (data.locator ?? data.selector)
                    await tab.page
                      .locator((data.locator ?? data.selector)!)
                      .evaluate(
                        `element => element.scrollBy(${data.deltaX ?? 0}, ${data.deltaY ?? 0})`,
                      );
                  else await tab.page.mouse.wheel(data.deltaX ?? 0, data.deltaY ?? 0);
                  return { tabId, scrolled: true };
                }
                case "evaluate": {
                  const data = input as PreviewAutomationEvaluateInput;
                  const evaluated = await tab.cdp.send("Runtime.evaluate", {
                    expression: data.expression,
                    awaitPromise: data.awaitPromise ?? true,
                    returnByValue: data.returnByValue ?? true,
                    userGesture: true,
                  });
                  if (evaluated.exceptionDetails)
                    throw new Error(
                      evaluated.exceptionDetails.exception?.description ??
                        evaluated.exceptionDetails.text,
                    );
                  const value =
                    data.returnByValue === false ? evaluated.result : evaluated.result.value;
                  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 2 * 1024 * 1024)
                    throw new Error(
                      "The browser result exceeds 2 MB. Read a smaller section of the page.",
                    );
                  return value;
                }
                case "waitFor": {
                  const data = input as PreviewAutomationWaitForInput;
                  if (data.locator ?? data.selector)
                    await tab.page
                      .locator((data.locator ?? data.selector)!)
                      .waitFor({ state: "visible", timeout: timeoutMs });
                  if (data.text !== undefined)
                    await tab.page.waitForFunction(
                      `document.body?.innerText.includes(${JSON.stringify(data.text)})`,
                      undefined,
                      { timeout: timeoutMs },
                    );
                  if (data.urlIncludes !== undefined)
                    await tab.page.waitForURL((url) => url.href.includes(data.urlIncludes!), {
                      timeout: timeoutMs,
                    });
                  return { tabId, matched: true };
                }
                case "resize": {
                  tab.viewport = resolvePreviewViewport(input as PreviewAutomationResizeInput);
                  const viewport = dimensions(tab.viewport);
                  await tab.page.setViewportSize(viewport);
                  return { tabId, setting: tab.viewport, viewport };
                }
                case "setColorScheme": {
                  const data = input as PreviewAutomationSetColorSchemeInput;
                  await tab.page.emulateMedia({
                    colorScheme: data.colorScheme === "system" ? null : data.colorScheme,
                  });
                  return { tabId, colorScheme: data.colorScheme };
                }
                case "agentBrowser": {
                  const data = decodeAgentArguments(input);
                  const invalid = agentBrowserCommandError(data.args);
                  if (invalid) throw new Error(invalid);
                  if (
                    tab.agentReferencesStale &&
                    getAgentBrowserCommandName(data.args) !== "snapshot"
                  )
                    throw new Error(
                      "The browser changed during human control. Run agent-browser snapshot -i before continuing so element references are current.",
                    );
                  const commandController = new AbortController();
                  tab.agentCommandController = commandController;
                  try {
                    tab.agentBrowserUsed = true;
                    tab.agentCdpProxy ??= await createAgentBrowserCdpProxy({
                      upstream: tab.host.cdp,
                      targetId: tab.targetId,
                    });
                    const proxy = tab.agentCdpProxy;
                    const signal = AbortSignal.any([
                      operationSignal,
                      commandController.signal,
                      AbortSignal.timeout(timeoutMs),
                    ]);
                    signal.throwIfAborted();
                    const abort = () => proxy.disconnect();
                    signal.addEventListener("abort", abort, { once: true });
                    proxy.activate();
                    try {
                      const result = await runAgentBrowser({
                        directory: NodePath.join(config.baseDir, "tools", "agent-browser"),
                        session: `t3-${digest(key(threadId, tabId))}`,
                        cdp: proxy.endpoint,
                        targetId: tab.targetId,
                        args: data.args,
                        signal,
                      });
                      if (
                        getAgentBrowserCommandName(data.args) === "snapshot" &&
                        result.exitCode === 0
                      )
                        tab.agentReferencesStale = false;
                      return result;
                    } catch (cause) {
                      proxy.disconnect();
                      throw cause;
                    } finally {
                      proxy.deactivate();
                      signal.removeEventListener("abort", abort);
                    }
                  } finally {
                    if (tab.agentCommandController === commandController)
                      tab.agentCommandController = null;
                  }
                }
                case "recordingStart": {
                  if (!tab.recording) {
                    await NodeFSP.mkdir(artifactDir, { recursive: true });
                    const attachmentId = createPendingAttachmentId("webm");
                    tab.recording = {
                      path: NodePath.join(artifactDir, `${attachmentId}.webm`),
                      attachmentId,
                      startedAt: timestamp(),
                    };
                    await updateCapture(tab);
                  }
                  return { tabId, recording: true, startedAt: tab.recording.startedAt };
                }
                case "recordingStop": {
                  const recording = tab.recording;
                  if (!recording) throw new Error("This browser tab is not recording.");
                  tab.recording = null;
                  await updateCapture(tab);
                  const sizeBytes = (await NodeFSP.stat(recording.path)).size;
                  return {
                    id: recording.attachmentId,
                    uploadedAttachmentId: recording.attachmentId,
                    tabId,
                    path: recording.path,
                    mimeType: "video/webm",
                    sizeBytes,
                    createdAt: recording.startedAt,
                  };
                }
                default:
                  throw new Error(`Browser operation ${operation} is unavailable.`);
              }
            })();
            const index = tab.actions.findIndex((entry) => entry.id === action.id);
            if (index >= 0)
              tab.actions[index] = { ...action, status: "succeeded", completedAt: timestamp() };
            await publishStatus(tab);
            return result;
          } catch (cause) {
            const index = tab.actions.findIndex((entry) => entry.id === action.id);
            if (index >= 0)
              tab.actions[index] = {
                ...action,
                status: "failed",
                completedAt: timestamp(),
                error:
                  cause instanceof Error ? cause.message.slice(0, 500) : "Browser operation failed",
              };
            throw cause;
          }
        });
      },
      catch: failure(threadId, tabId),
    });
  });

  const navigate = (threadId: string, tabId: string, url: string) =>
    invoke(threadId, tabId, "navigate", { url }, 30000).pipe(Effect.asVoid);
  const resize = Effect.fn("BrowserRuntime.resize")(function* (
    threadId: string,
    tabId: string,
    viewport: PreviewViewportSetting,
  ) {
    yield* Effect.tryPromise({
      try: () => {
        const tab = get(threadId, tabId);
        return tab.control.agent(async () => {
          tab.viewport = viewport;
          await tab.page.setViewportSize(dimensions(viewport));
        });
      },
      catch: failure(threadId, tabId),
    });
  });
  const refresh = Effect.fn("BrowserRuntime.refresh")(function* (threadId: string, tabId: string) {
    yield* Effect.tryPromise({
      try: () => {
        const tab = get(threadId, tabId);
        return tab.control.agent(async () => {
          await tab.page.reload({ timeout: 30000 });
          await publishStatus(tab);
        });
      },
      catch: failure(threadId, tabId),
    });
  });
  const close = Effect.fn("BrowserRuntime.close")(function* (threadId: string, tabId?: string) {
    yield* Effect.tryPromise({
      try: async () => {
        lifecycle.cancel(threadId, tabId);
        for (const tab of tabs.values()) {
          if (tab.threadId !== threadId || (tabId !== undefined && tab.tabId !== tabId)) continue;
          await disposeTab(tab);
        }
      },
      catch: failure(threadId, tabId),
    });
  });

  const attach = Effect.fn("BrowserRuntime.attach")(function* (
    threadId: string,
    tabId: string,
    send: (message: PreviewBrowserServerMessage) => void,
  ) {
    const tab = yield* Effect.try({
      try: () => get(threadId, tabId),
      catch: failure(threadId, tabId),
    });
    const id = NodeCrypto.randomUUID();
    const viewer: Viewer = {
      id,
      send,
      frames: new LatestBrowserFrame((frame) => send(frame)),
      maxFps: 10,
      pacer: new BrowserFramePacer(
        (frame) => viewer.frames.offer(frame),
        () => viewer.maxFps,
      ),
    };
    tab.viewers.set(id, viewer);
    broadcastControl(tab);
    yield* Effect.tryPromise({
      try: async () => {
        try {
          await updateCapture(tab);
          await publishStatus(tab);
          if (tab.frame) viewer.frames.offer(tab.frame);
        } catch (cause) {
          viewer.pacer.close();
          tab.viewers.delete(id);
          await tab.control.release(id);
          broadcastControl(tab);
          await updateCapture(tab).catch(() => undefined);
          throw cause;
        }
      },
      catch: failure(threadId, tabId),
    });
    const message = Effect.fn("BrowserViewer.message")(function* (
      packet: PreviewBrowserClientMessage,
    ) {
      yield* Effect.tryPromise({
        try: async () => {
          if (tab.closed || !tab.viewers.has(id))
            throw new Error("This browser viewer is no longer connected.");
          if (packet.type === "ack") {
            viewer.frames.ack(packet.seq);
            return;
          }
          if (packet.type === "config") {
            viewer.maxFps = Math.min(30, packet.maxFps ?? 10);
            return;
          }
          if (packet.type === "take_control") {
            const ownership = tab.control.take(id);
            if (tab.agentCommandController) {
              tab.agentCdpProxy?.disconnect();
              tab.agentCommandController.abort(new BrowserControlInterrupted());
            }
            await ownership;
            tab.agentReferencesStale = true;
            broadcastControl(tab);
            return;
          }
          if (packet.type === "release_control") {
            await tab.control.release(id);
            broadcastControl(tab);
            return;
          }
          await tab.control.human(id, async () => {
            switch (packet.type) {
              case "input_mouse":
                await tab.cdp.send("Input.dispatchMouseEvent", {
                  type: packet.eventType,
                  x: packet.x,
                  y: packet.y,
                  ...(packet.button === undefined ? {} : { button: packet.button }),
                  ...(packet.buttons === undefined ? {} : { buttons: packet.buttons }),
                  ...(packet.clickCount === undefined ? {} : { clickCount: packet.clickCount }),
                  ...(packet.modifiers === undefined ? {} : { modifiers: packet.modifiers }),
                  ...(packet.deltaX === undefined ? {} : { deltaX: packet.deltaX }),
                  ...(packet.deltaY === undefined ? {} : { deltaY: packet.deltaY }),
                });
                break;
              case "input_keyboard":
                await tab.cdp.send("Input.dispatchKeyEvent", {
                  type: packet.eventType,
                  ...(packet.key === undefined ? {} : { key: packet.key }),
                  ...(packet.code === undefined ? {} : { code: packet.code }),
                  ...(packet.text === undefined ? {} : { text: packet.text }),
                  ...(packet.modifiers === undefined ? {} : { modifiers: packet.modifiers }),
                  ...(packet.windowsVirtualKeyCode === undefined
                    ? {}
                    : { windowsVirtualKeyCode: packet.windowsVirtualKeyCode }),
                });
                break;
              case "input_touch":
                await tab.cdp.send("Input.dispatchTouchEvent", {
                  type: packet.eventType,
                  touchPoints: packet.touchPoints.map((point) => ({
                    x: point.x,
                    y: point.y,
                    ...(point.id === undefined ? {} : { id: point.id }),
                  })),
                });
                break;
              case "navigate":
                await tab.page.goto(normalizePreviewUrl(packet.url), { timeout: 30000 });
                break;
              case "back":
                await tab.page.goBack({ timeout: 30000 });
                break;
              case "forward":
                await tab.page.goForward({ timeout: 30000 });
                break;
              case "reload":
                await tab.page.reload({ timeout: 30000 });
                break;
              case "set_viewport": {
                tab.viewport = packet.viewport;
                const viewport =
                  packet.viewport._tag === "fill" && packet.width && packet.height
                    ? { width: packet.width, height: packet.height }
                    : dimensions(packet.viewport);
                await tab.page.setViewportSize(viewport);
                break;
              }
              case "set_color_scheme":
                await tab.page.emulateMedia({
                  colorScheme: packet.colorScheme === "system" ? null : packet.colorScheme,
                });
                break;
              case "resize": {
                if (packet.width * packet.height > 3840 * 2160)
                  throw new Error("The browser viewport is too large.");
                if (tab.viewport._tag === "fill")
                  await tab.page.setViewportSize({ width: packet.width, height: packet.height });
                break;
              }
            }
            await publishStatus(tab);
          });
        },
        catch: failure(threadId, tabId),
      });
    });
    const disconnect = Effect.promise(async () => {
      viewer.pacer.close();
      tab.viewers.delete(id);
      await tab.control.release(id);
      broadcastControl(tab);
      await updateCapture(tab).catch(() => undefined);
    });
    return { id, message, close: disconnect } satisfies BrowserViewerConnection;
  });

  return BrowserRuntime.of({
    open,
    has: (threadId, tabId) => tabs.has(key(threadId, tabId)),
    invoke,
    navigate,
    resize,
    refresh,
    close,
    attach,
  });
});

export const layer = Layer.effect(BrowserRuntime, make);
