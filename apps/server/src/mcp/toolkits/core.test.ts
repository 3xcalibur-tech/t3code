import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ChatImageAttachment,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpAttachmentInput } from "./attachment/input.ts";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerConfig from "../../config.ts";
import { OrchestratorProjectionError } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
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
import { DeviceToolkit } from "./device/tools.ts";
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
  threadId,
  providerSessionId: "mcp-core-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
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
    expect(result.structuredContent).toMatchObject({ code: "capability_denied" });
  }).pipe(
    Effect.provide(
      McpHttpServer.ThreadToolkitRegistrationLive.pipe(
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
    expect(result.structuredContent).toEqual({
      _tag: "OrchestratorMcpFailure",
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
  }).pipe(
    Effect.provide(
      McpHttpServer.ThreadToolkitRegistrationLive.pipe(
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
      McpHttpServer.HtmlToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-html-render-" })),
        Layer.provide(NodeServices.layer),
        // The preview browser is not installed in a fresh home, so nothing downloads.
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({ id: threadId, deletedAt: null } as OrchestrationV2ThreadShell),
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
