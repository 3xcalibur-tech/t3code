import { OrchestratorMcpFailure, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as AgentSettings from "../../../settings/AgentSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { readCaller, readFullAccessCaller } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}

const access = (fullAccessMessage?: string) =>
  Effect.gen(function* () {
    const context = yield* fullAccessMessage === undefined
      ? readCaller()
      : readFullAccessCaller(fullAccessMessage);
    const environment = yield* Environment.ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    if (descriptor.environmentId !== context.scope.environmentId)
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential belongs to another environment.",
      });
    return { ...context, descriptor };
  });
export const EnvironmentHandlersLive = EnvironmentToolkit.toLayer({
  t3_environment_read: ({ include = [] }) =>
    Effect.gen(function* () {
      const { descriptor } = yield* access(
        include.includes("settings")
          ? "Full settings include host paths and require a live full-access/default calling thread or a full-access client."
          : undefined,
      );
      const agentSettings = yield* AgentSettings.AgentSettings;
      const { current, settings, keybindings } = yield* agentSettings
        .read({
          settings: include.includes("settings"),
          keybindings: include.includes("keybindings"),
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "KeybindingsConfigParseError"
              ? new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "The keybindings file could not be read or written.",
                })
              : new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "The operation could not be completed.",
                }),
          ),
        );
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
        ...(settings ? { settings } : {}),
        ...(keybindings ? { keybindings } : {}),
      };
    }),
  t3_environment_preferences_update: ({ settings, providerInstance, keybinding, ...fields }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const agentSettings = yield* AgentSettings.AgentSettings;
      const update = Effect.gen(function* () {
        yield* access(
          "Preference updates require a live full-access/default thread or a full-access client.",
        );
        const { next, updated, keybindings } = yield* agentSettings
          .update({ fields, settings, providerInstance, keybinding })
          .pipe(
            Effect.mapError((error) => {
              switch (error._tag) {
                case "ServerSettingsError":
                  return new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: "The operation could not be completed.",
                  });
                case "KeybindingsConfigParseError":
                  return new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: "The keybindings file could not be read or written.",
                  });
                case "InvalidPreferencesInputError":
                  // The schema issue tells the agent which field to fix.
                  return new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: `Invalid ${error.input}: ${error.cause.message}`.slice(0, 2_000),
                  });
                default:
                  return new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: error.message.slice(0, 2_000),
                  });
              }
            }),
          );
        return { ...preferences(next), updated, ...(keybindings ? { keybindings } : {}) };
      });
      // A thread caller serializes with its own turn; a client has no thread to lock.
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
});
