import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { loadManagedPlaywright } from "./BrowserToolchain.ts";

it.effect("loads the browser registry from T3's cache and restores the caller's environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-toolchain-test-" });
      yield* fs.writeFileString(path.join(directory, "package.json"), '{"main":"index.cjs"}');
      yield* fs.writeFileString(
        path.join(directory, "index.cjs"),
        "const registry = process.env.PLAYWRIGHT_BROWSERS_PATH; exports.chromium = { executablePath: () => registry };",
      );
      const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
      const playwright = loadManagedPlaywright(directory, "/t3-owned/browser-cache");
      expect(playwright.chromium.executablePath()).toBe("/t3-owned/browser-cache");
      expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(previous);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
