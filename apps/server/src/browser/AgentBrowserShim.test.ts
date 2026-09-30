// @effect-diagnostics nodeBuiltinImport:off - Tests run the standalone Node launcher against a fixture HTTP server.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  AGENT_BROWSER_LAUNCHER_SOURCE,
  ensureAgentBrowserShim,
  removeAgentBrowserCredential,
} from "./AgentBrowserShim.ts";

async function runFixture(input: {
  args: string[];
  sse?: boolean;
  status?: number;
  output?: { stdout: string; stderr: string; exitCode: number };
}) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-shim-"));
  let request: { headers: import("node:http").IncomingHttpHeaders; body: unknown } | undefined;
  const server = NodeHttp.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    request = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.statusCode = input.status ?? 200;
    const message = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        structuredContent: input.output ?? {
          stdout: "button Login [ref=e1]\n",
          stderr: "",
          exitCode: 0,
        },
      },
    };
    res.setHeader("content-type", input.sse ? "text/event-stream" : "application/json");
    res.end(
      input.sse
        ? `event: message\r\ndata: ${JSON.stringify(message)}\r\n\r\n`
        : JSON.stringify(message),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture listener.");
    const launcher = NodePath.join(dir, "launcher.mjs");
    const config = NodePath.join(dir, "credential.json");
    await NodeFSP.writeFile(launcher, AGENT_BROWSER_LAUNCHER_SOURCE);
    await NodeFSP.writeFile(
      config,
      JSON.stringify({
        endpoint: `http://127.0.0.1:${address.port}/mcp`,
        authorizationHeader: "Bearer fixture-provider",
      }),
    );
    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
      (resolve, reject) => {
        const child = NodeChildProcess.spawn(process.execPath, [launcher, ...input.args], {
          env: { ...process.env, T3_AGENT_BROWSER_CONFIG: config },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
      },
    );
    return { ...result, request };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

describe("managed agent-browser launcher", () => {
  it.effect("does not leave a credential when publishing the executable launcher fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcessPlatform;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-publish-failure-" });
        const shimPath = path.join(
          dir,
          "browser",
          "bin",
          platform === "win32" ? "agent-browser.cmd" : "agent-browser",
        );
        const failed = yield* ensureAgentBrowserShim({
          stateDir: dir,
          session: {
            endpoint: "http://127.0.0.1:1234/mcp",
            authorizationHeader: "Bearer fixture",
            providerSessionId: "failed-session",
          },
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            rename: (source, destination) =>
              fs.rename(
                destination === shimPath ? path.join(dir, "missing-source") : source,
                destination,
              ),
          }),
          Effect.result,
        );
        expect(failed._tag).toBe("Failure");
        expect(yield* fs.readDirectory(path.join(dir, "browser", "sessions"))).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps session credentials private, replaces them atomically, and removes them on revocation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const platform = yield* HostProcessPlatform;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-credential-" });
          const session = {
            endpoint: "http://127.0.0.1:1234/mcp",
            authorizationHeader: "Bearer first",
            providerSessionId: "session-a",
          };
          const environment = yield* ensureAgentBrowserShim({ stateDir: dir, session });
          const configPath = environment.T3_AGENT_BROWSER_CONFIG;
          const decode = Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({ endpoint: Schema.String, authorizationHeader: Schema.String }),
            ),
          );
          expect(yield* decode(yield* fs.readFileString(configPath))).toEqual({
            endpoint: session.endpoint,
            authorizationHeader: session.authorizationHeader,
          });
          if (platform !== "win32") expect((yield* fs.stat(configPath)).mode & 0o777).toBe(0o600);
          yield* ensureAgentBrowserShim({
            stateDir: dir,
            session: { ...session, authorizationHeader: "Bearer replacement" },
          });
          expect(yield* fs.readFileString(configPath)).toContain("Bearer replacement");
          yield* removeAgentBrowserCredential(environment);
          expect(yield* fs.exists(configPath)).toBe(false);
          yield* removeAgentBrowserCredential(environment);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it("routes an exact T3 tab and literal arguments through provider-scoped MCP", async () => {
    const args = ["fill", "@e1", "hello ' $ world\nnext"];
    const result = await runFixture({ args: ["--t3-tab", "tab-a", ...args] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("button Login [ref=e1]\n");
    expect(result.request?.headers.authorization).toBe("Bearer fixture-provider");
    expect(result.request?.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "preview_agent_browser", arguments: { args, tabId: "tab-a" } },
    });
  });

  it("reads SSE results and preserves browser command exit status", async () => {
    const result = await runFixture({
      args: ["snapshot", "-i"],
      sse: true,
      output: { stdout: "", stderr: "The user is controlling this browser.", exitCode: 2 },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("The user is controlling this browser.\n");
    expect(result.request?.body).toMatchObject({
      params: { arguments: { args: ["snapshot", "-i"] } },
    });
  });

  it("reports expired credentials without leaking credentials or browser output", async () => {
    const result = await runFixture({ args: ["snapshot"], status: 401 });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("credential expired");
    expect(result.stderr).not.toContain("fixture-provider");
  });
});
