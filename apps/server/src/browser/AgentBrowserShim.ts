import * as NodeCrypto from "node:crypto";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { AGENT_BROWSER_VERSION } from "@t3tools/shared/agentBrowserRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { McpProviderSessionConfig } from "../mcp/McpProviderSession.ts";

const Config = Schema.Struct({ endpoint: Schema.String, authorizationHeader: Schema.String });
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(Config));

/** The launcher sends every command through the provider-scoped browser broker. */
export const AGENT_BROWSER_LAUNCHER_SOURCE = String.raw`import { readFile } from "node:fs/promises";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--version", "version"].includes(args[0])) {
    console.log("agent-browser ${AGENT_BROWSER_VERSION}, managed by T3");
    return;
  }
  if (args.length === 0 || (args.length === 1 && ["help", "--help", "-h"].includes(args[0]))) {
    console.log("T3 managed agent-browser. Call preview_open first.\nUsage: agent-browser [--t3-tab <tabId>] <command> [args]\nStart with: agent-browser snapshot -i\nLearn commands: agent-browser skills get core --full\nT3 supplies the browser and session and honors human takeover.");
    return;
  }
  const configPath = process.env.T3_AGENT_BROWSER_CONFIG;
  if (!configPath) throw new Error("Browser access is unavailable for this provider session.");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  let tabId;
  const command = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--t3-tab") {
      if (tabId !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Provide one --t3-tab value.");
      tabId = args[++i];
    } else if (args[i].startsWith("--t3-tab=")) {
      if (tabId !== undefined || !args[i].slice(9)) throw new Error("Provide one --t3-tab value.");
      tabId = args[i].slice(9);
    } else command.push(args[i]);
  }
  if (!command.length) throw new Error("Provide an agent-browser command.");
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: config.authorizationHeader },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "preview_agent_browser", arguments: { args: command, ...(tabId === undefined ? {} : { tabId }) } } }),
    signal: AbortSignal.timeout(75000),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "The T3 browser credential expired. Restart the agent session to restore browser access." : "T3 browser request failed: HTTP " + response.status);
  const text = await response.text();
  let message;
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      const candidate = JSON.parse(data);
      if (candidate.id === 1) message = candidate;
    }
  } else message = JSON.parse(text);
  if (!message || message.error) throw new Error(message?.error?.message ?? "T3 returned no browser command result.");
  const result = message.result;
  if (result?.isError) throw new Error((result.content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n") || "The browser command failed.");
  const output = result?.structuredContent ?? JSON.parse((result?.content ?? []).find(item => item.type === "text")?.text ?? "null");
  if (!output || typeof output.stdout !== "string" || typeof output.stderr !== "string" || !Number.isInteger(output.exitCode)) throw new Error("T3 returned an invalid browser command result.");
  if (output.stdout) process.stdout.write(output.stdout + (output.stdout.endsWith("\n") ? "" : "\n"));
  if (output.stderr) process.stderr.write(output.stderr + (output.stderr.endsWith("\n") ? "" : "\n"));
  process.exitCode = output.exitCode >= 0 && output.exitCode <= 255 ? output.exitCode : 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : "T3 browser command failed."); process.exitCode = 1; });
`;

export const ensureAgentBrowserShim = Effect.fn("AgentBrowserShim.ensure")(function* (input: {
  readonly stateDir: string;
  readonly session: Pick<
    McpProviderSessionConfig,
    "endpoint" | "authorizationHeader" | "providerSessionId"
  >;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const shimDir = path.join(input.stateDir, "browser", "bin");
  const sessionDir = path.join(input.stateDir, "browser", "sessions");
  yield* fs.makeDirectory(shimDir, { recursive: true });
  yield* fs.makeDirectory(sessionDir, { recursive: true, mode: 0o700 });
  const writeAtomic = Effect.fn("AgentBrowserShim.writeAtomic")(function* (
    destination: string,
    content: string,
    mode: number,
  ) {
    const temporary = yield* fs.makeTempFile({
      directory: path.dirname(destination),
      prefix: ".launcher-",
    });
    yield* Effect.gen(function* () {
      yield* fs.chmod(temporary, mode);
      yield* fs.writeFileString(temporary, content);
      yield* fs.rename(temporary, destination);
    }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
  });
  const launcherPath = path.join(shimDir, "agent-browser-launcher.mjs");
  yield* writeAtomic(launcherPath, AGENT_BROWSER_LAUNCHER_SOURCE, 0o644);
  const key = NodeCrypto.createHash("sha256").update(input.session.providerSessionId).digest("hex");
  const configPath = path.join(sessionDir, `${key}.json`);
  const node = process.execPath;
  if (platform === "win32") {
    yield* writeAtomic(
      path.join(shimDir, "agent-browser.cmd"),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${node}" "${launcherPath}" %*\r\n`,
      0o644,
    );
  } else {
    const command = [node, launcherPath]
      .map((value) => "'" + value.replaceAll("'", "'\"'\"'") + "'")
      .join(" ");
    const shim = path.join(shimDir, "agent-browser");
    yield* writeAtomic(
      shim,
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${command} "$@"\n`,
      0o755,
    );
  }
  const temp = yield* fs.makeTempFile({ directory: sessionDir, prefix: ".credential-" });
  yield* Effect.gen(function* () {
    yield* fs.chmod(temp, 0o600);
    yield* fs.writeFileString(
      temp,
      encodeConfig({
        endpoint: input.session.endpoint,
        authorizationHeader: input.session.authorizationHeader,
      }),
    );
    yield* fs.rename(temp, configPath);
  }).pipe(Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore)));
  return {
    PATH: shimDir,
    PATH_SEPARATOR: platform === "win32" ? ";" : ":",
    T3_AGENT_BROWSER_CONFIG: configPath,
  } satisfies Record<string, string>;
});

/** Remove the on-disk credential when its provider session is revoked. */
export const removeAgentBrowserCredential = Effect.fn("AgentBrowserShim.removeCredential")(
  function* (environment: Readonly<Record<string, string>> | undefined) {
    const configPath = environment?.T3_AGENT_BROWSER_CONFIG;
    if (!configPath) return;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(configPath, { force: true });
  },
);
