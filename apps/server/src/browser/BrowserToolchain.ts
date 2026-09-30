// @effect-diagnostics nodeBuiltinImport:off - Managed Playwright is loaded from its lazy runtime install.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type * as Playwright from "playwright-core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

class BrowserToolchainError extends Schema.TaggedError<BrowserToolchainError>()(
  "BrowserToolchainError",
  { message: Schema.String },
) {}
import * as ProcessRunner from "../processRunner.ts";

export const SERVER_PLAYWRIGHT_VERSION = "1.60.0";
const installLock = Semaphore.makeUnsafe(1);

/** Playwright caches its Chromium and FFmpeg registry paths when its module loads. */
export function loadManagedPlaywright(packageDir: string, browserPath: string) {
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath;
  try {
    return NodeModule.createRequire(import.meta.url)(packageDir) as typeof Playwright;
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
  }
}

/** Keeps Playwright assets and Chromium outside the server bundle and desktop installer. */
export const ensureBrowserToolchain = Effect.fn("BrowserToolchain.ensure")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const installDir = NodePath.join(baseDir, "tools", "browser", SERVER_PLAYWRIGHT_VERSION);
  const packageDir = NodePath.join(installDir, "node_modules", "playwright-core");
  const marker = NodePath.join(installDir, ".install-complete");
  const browserPath = NodePath.join(installDir, "chromium");
  return yield* installLock.withPermit(
    Effect.gen(function* () {
      const complete = yield* fs.exists(marker);
      if (!complete) {
        yield* fs.makeDirectory(installDir, { recursive: true });
        const npm = yield* runner.run({
          command: "npm",
          args: [
            "install",
            "--prefix",
            installDir,
            "--no-audit",
            "--no-fund",
            "--no-save",
            `playwright-core@${SERVER_PLAYWRIGHT_VERSION}`,
          ],
          timeout: "10 minutes",
          maxOutputBytes: 256 * 1024,
        });
        if (npm.code !== 0)
          return yield* Effect.fail(
            new BrowserToolchainError({
              message:
                "Installing the managed browser runtime failed. Ensure npm is installed and the npm registry is reachable.",
            }),
          );
        const download = yield* runner.run({
          command: process.execPath,
          args: [NodePath.join(packageDir, "cli.js"), "install", "chromium", "--no-shell"],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PLAYWRIGHT_BROWSERS_PATH: browserPath },
          timeout: "10 minutes",
          maxOutputBytes: 256 * 1024,
        });
        if (download.code !== 0)
          return yield* Effect.fail(
            new BrowserToolchainError({
              message:
                "Downloading Chromium failed. Retry when the Chrome download service is reachable.",
            }),
          );
        // Resolve the executable using the same installed registry that downloaded it.
        const resolve = yield* runner.run({
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write(require(process.argv[1]).chromium.executablePath())",
            packageDir,
          ],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PLAYWRIGHT_BROWSERS_PATH: browserPath },
          maxOutputBytes: 16 * 1024,
        });
        if (resolve.code !== 0 || !resolve.stdout || !(yield* fs.exists(resolve.stdout))) {
          return yield* Effect.fail(
            new BrowserToolchainError({
              message: "The Chromium download did not contain a usable browser executable.",
            }),
          );
        }
        yield* fs.writeFileString(marker, resolve.stdout);
      }
      const executablePath = yield* fs.readFileString(marker);
      if (!(yield* fs.exists(executablePath))) {
        yield* fs.remove(marker, { force: true });
        return yield* Effect.fail(
          new BrowserToolchainError({
            message:
              "The managed Chromium executable is missing. Reopen the browser to download it again.",
          }),
        );
      }
      const playwright = yield* Effect.try(() => loadManagedPlaywright(packageDir, browserPath));
      return { executablePath, playwright };
    }),
  );
});
