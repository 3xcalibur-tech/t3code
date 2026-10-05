import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

/**
 * Drivers whose model catalogs are published by the vendor. Other drivers
 * (OpenCode, Pi, ACP agents) list models from the user's own configuration,
 * such as local Ollama tags, so their model names stay out of analytics.
 */
const VENDOR_CATALOG_DRIVERS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "antigravity",
]);

export interface ProviderDimensions {
  readonly provider: string;
  readonly model?: string;
}

/**
 * Anonymous provider and model for a model selection. Instance ids are
 * user-defined, so only the driver kind is reported. The model is reported
 * only when it comes from a vendor catalog and is not a user-added custom model.
 */
export function providerDimensions(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): ProviderDimensions {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (provider === undefined) return { provider: "unknown" };
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  return VENDOR_CATALOG_DRIVERS.has(provider.driver) && model !== undefined && !model.isCustom
    ? { provider: provider.driver, model: model.slug }
    : { provider: provider.driver };
}

/** Event properties relating the agent that delegated work to the agent that received it. */
export function delegationProperties(input: {
  readonly tool: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly caller: ModelSelection;
  readonly target: ModelSelection;
}): Readonly<Record<string, unknown>> {
  const caller = providerDimensions(input.providers, input.caller);
  const target = providerDimensions(input.providers, input.target);
  return {
    tool: input.tool,
    callerProvider: caller.provider,
    ...(caller.model === undefined ? {} : { callerModel: caller.model }),
    targetProvider: target.provider,
    ...(target.model === undefined ? {} : { targetModel: target.model }),
    crossProvider: caller.provider !== target.provider,
  };
}
