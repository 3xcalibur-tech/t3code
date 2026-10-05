import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { delegationProperties } from "./ProviderDimensions.ts";

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

it("relates the delegating and receiving agents by driver and catalog model", () => {
  expect(
    delegationProperties({
      tool: "delegate_task",
      providers,
      caller: selection("work-codex", "gpt-5.5"),
      target: selection("claudeAgent", "claude-opus-5-5"),
    }),
  ).toEqual({
    tool: "delegate_task",
    callerProvider: "codex",
    callerModel: "gpt-5.5",
    targetProvider: "claudeAgent",
    targetModel: "claude-opus-5-5",
    crossProvider: true,
  });
});

it("omits custom, user-configured, and unknown models and instance names", () => {
  const properties = delegationProperties({
    tool: "create_threads",
    providers,
    caller: selection("claudeAgent", "my-private-finetune"),
    target: selection("opencode", "ollama/acme-internal"),
  });
  expect(properties).toEqual({
    tool: "create_threads",
    callerProvider: "claudeAgent",
    targetProvider: "opencode",
    crossProvider: true,
  });
  expect(
    delegationProperties({
      tool: "t3_thread_launch",
      providers,
      caller: selection("removed-instance", "gpt-5.5"),
      target: selection("work-codex", "gpt-5.5"),
    }),
  ).toEqual({
    tool: "t3_thread_launch",
    callerProvider: "unknown",
    targetProvider: "codex",
    targetModel: "gpt-5.5",
    crossProvider: true,
  });
});
