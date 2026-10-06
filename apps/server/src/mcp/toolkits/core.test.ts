import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ChatImageAttachment,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpAttachmentInput } from "./attachment/input.ts";
import { McpSchema, McpServer, Tool } from "effect/ai";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../../config.ts";
import { OrchestratorProjectionError } from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as AgentSettings from "../../settings/AgentSettings.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Keybindings from "../../keybindings.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import { OrchestratorToolkit } from "./orchestrator/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";
import { EnvironmentToolkit } from "./environment/tools.ts";
import * as EnvironmentHandlers from "./environment/handlers.ts";
import { ProjectToolkit } from "./project/tools.ts";
import { AttachmentToolkit } from "./attachment/tools.ts";
import * as AttachmentHandlers from "./attachment/handlers.ts";
import { ThreadToolkit } from "./thread/tools.ts";
import { WorktreeToolkit } from "./worktree/tools.ts";
import { ReviewToolkit } from "./review/tools.ts";
import { GitToolkit } from "./git/tools.ts";
import { TerminalToolkit } from "./terminal/tools.ts";
import { ProviderToolkit } from "./provider/tools.ts";
import { ClientToolkit } from "./client/tools.ts";
import { DeviceToolkit } from "./device/tools.ts";

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};
import { PullRequestsToolkit } from "./pullRequests/tools.ts";
import { HtmlToolkit } from "./html/tools.ts";
import {
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
  resolveT3McpToolSummaryAction,
} from "@t3tools/shared/t3McpToolPresentation";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";

const decodeMcpAttachmentInput = Schema.decodeUnknownEffect(McpAttachmentInput);

it("publishes unique tool names with reference-free object-root inputs", () => {
  const names = new Set<string>();
  for (const toolkit of [
    OrchestratorToolkit,
    PreviewToolkit,
    WorktreeToolkit,
    ReviewToolkit,
    GitToolkit,
    TerminalToolkit,
    ProviderToolkit,
    ClientToolkit,
    ThreadToolkit,
    AttachmentToolkit,
    ProjectToolkit,
    EnvironmentToolkit,
    PreviewControlsToolkit,
    DeviceToolkit,
    PullRequestsToolkit,
    HtmlToolkit,
  ]) {
    for (const tool of Object.values(toolkit.tools)) {
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      const schema = Tool.getJsonSchema(tool);
      expect(schema).toMatchObject({ type: "object" });
      // The published tool catalog must also work with providers without $ref support.
      expect(JSON.stringify(schema), tool.name).not.toContain('"$ref"');
      // Every published tool must have labels for its lifecycle, branding, and a summary.
      const definition = resolveT3McpToolDefinition(tool.name);
      expect(definition, tool.name).not.toBeNull();
      expect(
        definition?.labels.every((label) => label.trim().length > 0),
        tool.name,
      ).toBe(true);
      for (const name of [tool.name, `mcp__t3-code__${tool.name}`, `T3-code.${tool.name}`]) {
        expect(resolveT3McpToolPresentation(name)?.logo, name).toBe("t3-code");
        expect(resolveT3McpToolSummaryAction(name), name).not.toBeNull();
      }
    }
  }
  expect(names.has("t3_thread_launch")).toBe(true);
  expect(names.has("t3_thread_start")).toBe(false);
});

const threadId = ThreadId.make("mcp-core-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "mcp-core-session",
  thread: {
    threadId,
    providerSessionId: "mcp-core-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-core", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-core", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("checks capability before accessing services through the production registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.some(({ tool }) => tool.name === "t3_thread_organize")).toBe(true);
    const result = yield* server
      .callTool({ name: "t3_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...scope,
          capabilities: new Set<never>(),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({ code: "capability_denied" });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
      ),
    ),
  ),
);

it.effect("returns a bounded public failure without serializing storage causes", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "t3_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toEqual({
      _tag: "OrchestratorMcpFailure",
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.fail(
                new OrchestratorProjectionError({
                  threadId,
                  cause: new Error("private-storage-path"),
                }),
              ),
          }),
        ),
      ),
    ),
  ),
);

it.effect("returns an HTML render reference that Codex and Claude tool rows both carry", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "html_render",
        arguments: { html: "<p>Revenue</p>", title: "Revenue", height: 240 },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    const reference = htmlRenderFromToolItem({
      toolName: "t3-code.html_render",
      output: result.structuredContent,
    });
    expect(reference).toMatchObject({ title: "Revenue", height: 240 });
    expect(
      htmlRenderFromToolItem({ toolName: "mcp__t3-code__html_render", output: result.content }),
    ).toEqual(reference);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerHtmlToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(PreviewBrowser.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-html-render-" })),
        Layer.provide(NodeServices.layer),
        // The preview browser is not installed in a fresh home, so nothing downloads.
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            // A live run: publishing stores a page, so it needs the caller's active turn.
            getThreadShell: () =>
              Effect.succeed({
                id: threadId,
                deletedAt: null,
                archivedAt: null,
                activeRunId: RunId.make("mcp-core-run"),
                providerInstanceId: ProviderInstanceId.make("codex"),
              } as OrchestrationV2ThreadShell),
          }),
        ),
      ),
    ),
  ),
);

it("keeps MCP preference output allowlisted and Unicode-bounded", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    privateCredential: "must-not-escape",
    sourceControlWritingStyle: {
      ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
      customInstructions: "🙂".repeat(4001),
    },
  };
  const result = EnvironmentHandlers.preferences(settings);
  expect(result).not.toHaveProperty("privateCredential");
  expect(result).not.toHaveProperty("providers");
  expect(result.sourceControlWritingStyle).toMatchObject({
    customInstructions: "🙂".repeat(4000),
    truncated: true,
  });
});

it.effect("resolves reused attachment references from stored metadata", () =>
  Effect.gen(function* () {
    const stored = ChatImageAttachment.make({
      type: "image",
      id: "owned-image",
      name: "original.png",
      mimeType: "image/png",
      sizeBytes: 12,
      source: {
        kind: "snap-shot",
        capturedAt: "2026-09-10T00:00:00.000Z",
        appName: "Terminal",
        windowTitle: "Test",
        accessibility: { format: "flat-text", text: "Stored context", truncated: false },
      },
    });
    const forged = yield* decodeMcpAttachmentInput({
      type: "image",
      id: stored.id,
      name: "changed.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 99,
    });
    const result = yield* AttachmentHandlers.resolveAttachmentReferences([forged], [stored]);
    expect(result).toEqual([stored]);
    const failure = yield* AttachmentHandlers.resolveAttachmentReferences(
      [{ ...forged, id: "other-image" }],
      [stored],
    ).pipe(Effect.flip);
    expect(failure.code).toBe("invalid_request");
  }),
);

const clientScope = (
  runtimeModeCeiling: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", runtimeModeCeiling },
  issuedAt: 0,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
});

it.effect("a client caller targets any thread within its ceiling and cannot act as a thread", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const untargeted = yield* call("t3_thread_organize", { action: "pin" }, clientScope("auto"));
    expect(declaredFailure(untargeted)).toMatchObject({ code: "target_required" });

    const pinned = yield* call(
      "t3_thread_organize",
      { action: "pin", threadId: "other-project-thread" },
      clientScope("auto"),
    );
    expect(pinned.isError).toBe(false);
    expect(pinned.structuredContent).toMatchObject({ sequence: 7 });

    const aboveCeiling = yield* call(
      "t3_thread_organize",
      { action: "pin", threadId: "other-project-thread" },
      clientScope("approval-required"),
    );
    expect(declaredFailure(aboveCeiling)).toMatchObject({
      code: "runtime_mode_escalation_denied",
    });

    const forked = yield* call(
      "t3_thread_fork",
      { sourcePoint: { type: "latest_stable" } },
      clientScope("auto"),
    );
    expect(declaredFailure(forked)).toMatchObject({ code: "target_required" });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                id: ThreadId.make("other-project-thread"),
                projectId: "other-project",
                deletedAt: null,
              } as never),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("other-project-thread"),
                  projectId: "other-project",
                  runtimeMode: "auto",
                  interactionMode: "default",
                  deletedAt: null,
                },
              } as never),
            dispatch: () => Effect.succeed({ sequence: 7 } as never),
          }),
        ),
      ),
    ),
  ),
);

it.effect("refuses act-as-caller tools to a client caller", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "delegate_task",
        arguments: { task: "Review", mode: "async" },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          clientScope("full-access"),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({ code: "thread_credential_required" });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);

it.effect("a caller cannot rewrite a scheduled task that runs above its own modes", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const update = yield* call("update_scheduled_task", {
      scheduledTaskId: "task-full-access",
      prompt: "Run something else",
    });
    expect(declaredFailure(update)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const remove = yield* call("delete_scheduled_task", { scheduledTaskId: "task-full-access" });
    expect(declaredFailure(remove)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const allowed = yield* call("update_scheduled_task", {
      scheduledTaskId: "task-auto",
      enabled: false,
    });
    expect(allowed.isError).toBe(false);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            list: () =>
              Effect.succeed({
                tasks: [
                  scheduledTask("task-full-access", "full-access"),
                  scheduledTask("task-auto", "auto"),
                ],
              }),
            upsert: (input) =>
              Effect.succeed({
                task: { ...(scheduledTask(input.id ?? "task-auto", "auto") as object), ...input },
              } as never),
          }),
        ),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);

function scheduledTask(id: string, runtimeMode: "auto" | "full-access"): never {
  return {
    id,
    title: id,
    prompt: "Check the build",
    enabled: true,
    projectId: "project-a",
    threadId: null,
    schedule: { type: "interval", everyMs: 3_600_000 },
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode,
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    nextRunAt: null,
    lastRunStatus: "never",
    lastRunAt: null,
    lastRunThreadId: null,
    lastRunError: null,
    runCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as never;
}

it.effect("a caller cannot interrupt a thread that runs above its own modes", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "t3_thread_interrupt", arguments: { threadId: "full-access-thread" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({ code: "runtime_mode_escalation_denied" });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({ projectId: "project-a", deletedAt: null } as never),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("full-access-thread"),
                  projectId: "project-a",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  deletedAt: null,
                },
                runs: [],
              } as never),
            interruptThread: () => Effect.die("interrupt must not dispatch above the ceiling"),
          }),
        ),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);

it.effect("redacts every credential from MCP settings", () =>
  Effect.gen(function* () {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        antigravity: { ...DEFAULT_SERVER_SETTINGS.providers.antigravity, apiKey: "secret-api-key" },
        cursor: {
          ...DEFAULT_SERVER_SETTINGS.providers.cursor,
          apiEndpoint: "https://user:secret-cursor@example.com/api?token=secret-cursor-query",
        },
      },
      providerInstances: {
        [ProviderInstanceId.make("opencode_2")]: {
          driver: ProviderDriverKind.make("opencode"),
          config: { serverPassword: "secret-password" },
          environment: [{ name: "TOKEN", value: "secret-env", sensitive: true }],
        },
      },
      bitbucket: { email: "", accessToken: "secret-token", apiToken: "" },
      usageLimitSources: {
        proxy: {
          kind: "cliproxy",
          url: "https://user:secret-url-password@example.com/usage?key=secret-query",
          managementKey: "secret-management-key",
          enabled: true,
        },
      },
      observability: {
        ...DEFAULT_SERVER_SETTINGS.observability,
        otlpTracesUrl: "https://user:secret-traces@example.com/v1/traces",
        otlpMetricsUrl: "https://example.com/v1/metrics?token=secret-metrics",
        otlpLogsUrl: "https://example.com/v1/logs#access_token=secret-logs",
      },
    } as typeof DEFAULT_SERVER_SETTINGS;
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      yield* AgentSettings.redactSettingsForAgent(settings),
    );
    for (const secret of [
      "secret-api-key",
      "secret-password",
      "secret-env",
      "secret-token",
      "secret-url-password",
      "secret-query",
      "secret-management-key",
      "secret-traces",
      "secret-metrics",
      "secret-logs",
      "secret-cursor",
      "secret-cursor-query",
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain("https://example.com/usage");
    expect(text).toContain("https://example.com/v1/traces");
    expect(text).toContain("https://example.com/v1/metrics");
    expect(text).toContain("https://example.com/v1/logs");
    expect(text).toContain("https://example.com/api");
  }),
);

it.effect("rejects credential-bearing endpoint updates before persisting settings", () =>
  Effect.gen(function* () {
    const settings = yield* AgentSettings.AgentSettings;
    for (const patch of [
      { providers: { opencode: { serverUrl: "https://user:secret@example.com" } } },
      { observability: { otlpTracesUrl: "https://example.com/traces?token=secret" } },
      { observability: { otlpMetricsUrl: "https://user:secret@example.com/metrics" } },
      { observability: { otlpLogsUrl: "https://example.com/logs?token=secret" } },
      { observability: { otlpLogsUrl: "https://example.com/logs#access_token=secret" } },
    ]) {
      const error = yield* settings.update({ fields: {}, settings: patch }).pipe(Effect.flip);
      expect(error._tag).toBe("CredentialSettingsRejectedError");
      expect(error.message).not.toContain("secret");
    }
    const updated = yield* settings.update({
      fields: {},
      settings: { observability: { otlpTracesUrl: "https://example.com/traces" } },
    });
    expect(updated.next.observability.otlpTracesUrl).toBe("https://example.com/traces");
    const legacyEndpoint = yield* settings
      .update({
        fields: {},
        settings: { providers: { cursor: { apiEndpoint: "https://user:secret@example.com" } } },
      })
      .pipe(Effect.flip);
    expect(legacyEndpoint._tag).toBe("InvalidPreferencesInputError");
  }).pipe(
    Effect.provide(
      AgentSettings.layer.pipe(
        Layer.provide(Layer.mock(Keybindings.Keybindings)({})),
        Layer.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            updateSettings: (patch) => {
              expect(patch).toEqual({
                observability: { otlpTracesUrl: "https://example.com/traces" },
              });
              return Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                observability: { ...DEFAULT_SERVER_SETTINGS.observability, ...patch.observability },
              });
            },
          }),
        ),
      ),
    ),
  ),
);

it.effect(
  "preserves newer provider metadata when an agent changes preferences from a stale read",
  () =>
    Effect.gen(function* () {
      const service = yield* ServerSettings.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("opencode_work");
      const original = yield* service.getSettings;
      const edited = {
        driver: ProviderDriverKind.make("opencode"),
        displayName: "Updated in settings",
        enabled: true,
        config: { serverUrl: "https://new.example", customModels: [] },
        environment: [{ name: "NEW_SETTING", value: "preserved", sensitive: false }],
      };
      yield* service.updateProviderInstance({ operation: "upsert", instanceId, instance: edited });
      const result = yield* Effect.gen(function* () {
        const agentSettings = yield* AgentSettings.AgentSettings;
        return yield* agentSettings.update({
          fields: {},
          providerInstance: { instanceId, enabled: false },
        });
      }).pipe(
        Effect.provide(
          AgentSettings.layer.pipe(
            Layer.provide(
              Layer.succeed(ServerSettings.ServerSettingsService, {
                ...service,
                getSettings: Effect.succeed(original),
              }),
            ),
            Layer.provide(Layer.mock(Keybindings.Keybindings)({})),
          ),
        ),
      );
      expect(result.next.providerInstances[instanceId]).toMatchObject({
        ...edited,
        enabled: false,
      });
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("opencode_work")]: {
              driver: ProviderDriverKind.make("opencode"),
              enabled: true,
              config: { serverUrl: "https://old.example", customModels: [] },
            },
          },
        }),
      ),
    ),
);
