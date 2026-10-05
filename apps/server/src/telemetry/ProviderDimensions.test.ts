import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { agentToolProperties } from "./ProviderDimensions.ts";

const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; isCustom: boolean }>,
) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    models,
  }) as unknown as ServerProvider;

const providers = [
  provider("work-codex", "codex", [{ slug: "gpt-5.5", isCustom: false }]),
  provider("claudeAgent", "claudeAgent", [
    { slug: "claude-opus-5-5", isCustom: false },
    { slug: "my-private-finetune", isCustom: true },
  ]),
  provider("opencode", "opencode", [{ slug: "ollama/acme-internal", isCustom: false }]),
];

const selection = (instanceId: string, model: string) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

it("relates the calling agent to each agent it acted on", () => {
  expect(
    agentToolProperties({
      tool: "create_threads",
      providers,
      caller: selection("work-codex", "gpt-5.5"),
      targets: [selection("claudeAgent", "claude-opus-5-5"), selection("work-codex", "gpt-5.5")],
    }),
  ).toEqual([
    {
      tool: "create_threads",
      callerProvider: "codex",
      callerModel: "gpt-5.5",
      targetProvider: "claudeAgent",
      targetModel: "claude-opus-5-5",
      crossProvider: true,
    },
    {
      tool: "create_threads",
      callerProvider: "codex",
      callerModel: "gpt-5.5",
      targetProvider: "codex",
      targetModel: "gpt-5.5",
      crossProvider: false,
    },
  ]);
});

it("reports only the caller for tools that act on no other thread", () => {
  expect(
    agentToolProperties({
      tool: "preview_click",
      providers,
      caller: selection("claudeAgent", "claude-opus-5-5"),
      targets: [],
    }),
  ).toEqual([
    { tool: "preview_click", callerProvider: "claudeAgent", callerModel: "claude-opus-5-5" },
  ]);
});

it("omits custom, user-configured, and unknown models and instance names", () => {
  expect(
    agentToolProperties({
      tool: "t3_thread_send",
      providers,
      caller: selection("claudeAgent", "my-private-finetune"),
      targets: [selection("opencode", "ollama/acme-internal")],
    }),
  ).toEqual([
    {
      tool: "t3_thread_send",
      callerProvider: "claudeAgent",
      targetProvider: "opencode",
      crossProvider: true,
    },
  ]);
  expect(
    agentToolProperties({
      tool: "t3_thread_fork",
      providers,
      caller: undefined,
      targets: [selection("removed-instance", "gpt-5.5")],
    }),
  ).toEqual([
    {
      tool: "t3_thread_fork",
      callerProvider: "unknown",
      targetProvider: "unknown",
      crossProvider: false,
    },
  ]);
});
