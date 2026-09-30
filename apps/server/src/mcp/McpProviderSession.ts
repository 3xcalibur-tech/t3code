import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /** Routes the managed browser CLI through this session's MCP credential. */
  readonly agentBrowserEnvironment?: Readonly<Record<string, string>>;
}

/** Adds managed tool launchers while preserving provider credentials and PATH. */
export function withAgentToolEnvironment(
  base: NodeJS.ProcessEnv,
  config:
    | Pick<McpProviderSessionConfig, "agentDeviceEnvironment" | "agentBrowserEnvironment">
    | undefined,
): NodeJS.ProcessEnv {
  if (
    !config?.agentDeviceEnvironment &&
    !config?.agentBrowserEnvironment &&
    base.T3_AGENT_BROWSER_CONFIG === undefined
  )
    return base;
  const environment = { ...base };
  // Nested T3 servers must not lend an ancestor provider's browser credential
  // to a new session that has different permissions or thread ownership.
  delete environment.T3_AGENT_BROWSER_CONFIG;
  for (const extra of [config?.agentDeviceEnvironment, config?.agentBrowserEnvironment]) {
    if (!extra) continue;
    const separator = extra.PATH_SEPARATOR ?? ":";
    const basePath = environment.PATH ?? environment.Path;
    const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
    Object.assign(environment, rest);
    if (shimDir) environment.PATH = basePath ? `${shimDir}${separator}${basePath}` : shimDir;
  }
  return environment;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}

export function listMcpProviderSessions(): ReadonlyArray<McpProviderSessionConfig> {
  return [...sessionsByThread.values()];
}
