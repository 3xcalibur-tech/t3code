import "vite-plus/test/config";
import * as NodeURL from "node:url";
import type { UserConfig } from "vite-plus";

/**
 * Test settings every workspace package starts from. Vitest only reads the
 * config in the directory it runs from, so each package's vite.config.ts
 * uses this rather than inheriting it from the root.
 */
export default {
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: [
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/longTempDir.ts", import.meta.url),
      ),
    ],
  },
} satisfies UserConfig;
