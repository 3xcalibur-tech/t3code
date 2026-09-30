// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Native runtime provisioning and CLI processes are consumed through Promise adapter boundaries.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

/** The CLI is a separate native process; desktop reuses Electron's existing guest. */
export const AGENT_BROWSER_VERSION = "0.37.1";
import { HostProcessArchitecture, HostProcessPlatform } from "./hostProcess.ts";

const RELEASE_HASHES: Readonly<Record<string, string>> = {
  "darwin-arm64": "e52f06476ea0f1d14357c1924ce1d7f1bf08279f2642d74ccfa7ee935c46aea1",
  "darwin-x64": "c79d1e0525c0bf79df9eec355269ae40bcda9c4a3fce3f242c24faecaaaeef84",
  "linux-arm64": "d54d3e1262dc1aa0906e0677adc6d0cbb40d1274631f4cf77136bf23a0bc20e9",
  "linux-x64": "f8e5f9294bd0da70dda61854f12004fd61c668cd682bfb600cdf6d0df73dea69",
  "linux-musl-arm64": "ab7afc4e74d1218d32bd12519474dbd6ed9bf32b3a905d7648e9d9400f50083d",
  "linux-musl-x64": "5318f2ed03a9fae04a9e1f8d274d1a0fd6bf7fd427f32a44224be11f2dc3a37d",
  "win32-x64": "29a003139ff4eb96fa4d1ed341830b26eb3e082843bf776b4e88ad3443bb8fde",
};
const installations = new Map<string, Promise<string>>();

export function agentBrowserBinaryPlatform() {
  const architecture =
    HostProcessPlatform.defaultValue() === "win32" &&
    HostProcessArchitecture.defaultValue() === "arm64"
      ? "x64"
      : HostProcessArchitecture.defaultValue();
  const report =
    HostProcessPlatform.defaultValue() === "linux" ? process.report?.getReport() : undefined;
  const header =
    report && typeof report === "object" && "header" in report ? report.header : undefined;
  const musl =
    HostProcessPlatform.defaultValue() === "linux" &&
    header &&
    typeof header === "object" &&
    !("glibcVersionRuntime" in header);
  return `${HostProcessPlatform.defaultValue()}${musl ? "-musl" : ""}-${architecture}`;
}

export async function ensureAgentBrowserRuntime(input: { directory: string }) {
  const platform = agentBrowserBinaryPlatform();
  const hash = RELEASE_HASHES[platform];
  if (!hash) throw new Error(`agent-browser does not support ${platform}.`);
  const name = `agent-browser-${platform}${HostProcessPlatform.defaultValue() === "win32" ? ".exe" : ""}`;
  const directory = NodePath.join(input.directory, AGENT_BROWSER_VERSION);
  const executable = NodePath.join(directory, name);
  const existing = installations.get(executable);
  if (existing) return existing;
  const install = (async () => {
    await NodeFSP.mkdir(directory, { recursive: true });
    try {
      if (
        NodeCrypto.createHash("sha256")
          .update(await NodeFSP.readFile(executable))
          .digest("hex") === hash
      )
        return executable;
    } catch {
      /* A missing or incomplete installation is replaced atomically. */
    }
    const response = await fetch(
      `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${name}`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!response.ok) throw new Error(`Downloading agent-browser failed: HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== hash)
      throw new Error("agent-browser download checksum did not match the pinned release.");
    const temporary = `${executable}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      await NodeFSP.writeFile(temporary, bytes, { mode: 0o755 });
      await NodeFSP.chmod(temporary, 0o755);
      await NodeFSP.rename(temporary, executable);
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
    return executable;
  })();
  installations.set(executable, install);
  try {
    return await install;
  } catch (error) {
    installations.delete(executable);
    throw error;
  }
}

export interface AgentBrowserRunInput {
  directory: string;
  session: string;
  cdp: string;
  args: ReadonlyArray<string>;
  targetId: string;
  signal?: AbortSignal;
}

export function agentBrowserSocketDirectory(directory: string) {
  const hash = NodeCrypto.createHash("sha256").update(directory).digest("hex").slice(0, 12);
  return NodePath.join(NodeOS.tmpdir(), `t3-agent-browser-${process.getuid?.() ?? "user"}`, hash);
}

export function agentBrowserEnvironment(socketDirectory: string) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("AGENT_BROWSER_")),
  );
  return {
    ...environment,
    AGENT_BROWSER_SOCKET_DIR: socketDirectory,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "600000",
  };
}

export async function runAgentBrowser(input: AgentBrowserRunInput) {
  try {
    const executable = await withAbort(ensureAgentBrowserRuntime(input), input.signal);
    const socketDirectory = agentBrowserSocketDirectory(input.directory);
    await NodeFSP.mkdir(socketDirectory, { recursive: true, mode: 0o700 });
    const config = NodePath.join(socketDirectory, "config.json");
    await NodeFSP.writeFile(config, "{}", { mode: 0o600 });
    await ensureTargetBinding(socketDirectory, input.session, input.targetId);
    const options = [
      "--config",
      config,
      "--session",
      input.session,
      "--cdp",
      input.cdp,
      "--pin-tab",
    ];
    return await executeAgentBrowser(
      executable,
      [...options, ...input.args],
      socketDirectory,
      input.signal,
    );
  } catch (error) {
    if (input.signal?.aborted) {
      try {
        await closeAgentBrowserSession(input);
      } catch (cleanupError) {
        throw new Error(
          "agent-browser was interrupted, but its sidecar did not confirm shutdown. The browser transport remains disabled.",
          { cause: cleanupError },
        );
      }
      if (error instanceof Error && error.name === "AbortError") throw input.signal.reason;
    }
    throw error;
  }
}

async function withAbort<A>(promise: Promise<A>, signal?: AbortSignal): Promise<A> {
  if (!signal) return await promise;
  if (signal.aborted) throw signal.reason;
  return await new Promise<A>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function ensureTargetBinding(directory: string, session: string, targetId: string) {
  const file = NodePath.join(directory, `${session}.target`);
  let existing: string | undefined;
  try {
    existing = await NodeFSP.readFile(file, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (existing !== undefined) {
    const binding: unknown = JSON.parse(existing);
    if (
      binding &&
      typeof binding === "object" &&
      "targetId" in binding &&
      binding.targetId === targetId
    )
      return;
    // A closed or crashed browser leaves its pinned target file behind. Only
    // a live sidecar prevents rebinding the session to a newly opened tab.
    const watcher = await watchDaemonShutdown(directory, session, AbortSignal.timeout(5000));
    if (watcher) {
      watcher.socket.destroy();
      throw new Error("The managed agent-browser session belongs to a different target.");
    }
  }
  // In the pinned CLI a first --pin-tab attach creates a fresh tab unless this
  // documented persistent binding exists. Seed it before starting the daemon.
  // Repeating `tab <target>` instead would clear accessibility refs each call.
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, JSON.stringify({ targetId, url: "", pinned: true }), {
      mode: 0o600,
    });
    await NodeFSP.rename(temporary, file);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

export async function closeAgentBrowserSession(input: { directory: string; session: string }) {
  const platform = agentBrowserBinaryPlatform();
  const executable = NodePath.join(
    input.directory,
    AGENT_BROWSER_VERSION,
    `agent-browser-${platform}${HostProcessPlatform.defaultValue() === "win32" ? ".exe" : ""}`,
  );
  const socketDirectory = agentBrowserSocketDirectory(input.directory);
  try {
    await NodeFSP.access(executable);
    await NodeFSP.access(NodePath.join(socketDirectory, `${input.session}.pid`));
  } catch {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  const deadline = AbortSignal.timeout(5000);
  const watcher = await watchDaemonShutdown(socketDirectory, input.session, deadline);
  if (!watcher) return { stdout: "", stderr: "", exitCode: 0 };
  try {
    const result = await executeAgentBrowser(
      executable,
      [
        "--config",
        NodePath.join(socketDirectory, "config.json"),
        "--session",
        input.session,
        "close",
      ],
      socketDirectory,
      deadline,
    );
    if (result.exitCode !== 0)
      throw new Error(`agent-browser shutdown failed: ${result.stderr.trim()}`);
    await withAbort(watcher.closed, deadline);
    await NodeFSP.rm(NodePath.join(socketDirectory, `${input.session}.target`), { force: true });
    return result;
  } finally {
    watcher.socket.destroy();
  }
}

async function watchDaemonShutdown(directory: string, session: string, signal: AbortSignal) {
  if (HostProcessPlatform.defaultValue() === "win32") {
    try {
      await NodeFSP.access(NodePath.join(directory, `${session}.port`));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  const endpoint =
    HostProcessPlatform.defaultValue() === "win32"
      ? {
          host: "127.0.0.1",
          port: Number(await NodeFSP.readFile(NodePath.join(directory, `${session}.port`), "utf8")),
        }
      : { path: NodePath.join(directory, `${session}.sock`) };
  const socket = NodeNet.createConnection(endpoint);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  try {
    await withAbort(
      new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      }),
      signal,
    );
    return { socket, closed };
  } catch (error) {
    socket.destroy();
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ECONNREFUSED" || error.code === "ENOENT")
    )
      return undefined;
    throw error;
  }
}

function executeAgentBrowser(
  executable: string,
  args: string[],
  socketDirectory: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(executable, args, {
      cwd: socketDirectory,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal,
      env: agentBrowserEnvironment(socketDirectory),
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    const append = (stream: "stdout" | "stderr", data: Buffer) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + data.length > 1_000_000) {
        child.kill();
        failure = new Error("agent-browser output exceeded 1 MB.");
        return;
      }
      if (stream === "stdout") stdout += data.toString();
      else stderr += data.toString();
    };
    child.stdout.on("data", (data: Buffer) => append("stdout", data));
    child.stderr.on("data", (data: Buffer) => append("stderr", data));
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      if (failure) reject(failure);
      else resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
