// @effect-diagnostics nodeBuiltinImport:off
// Shared with the standalone service launcher. Keep imports limited to native modules.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Never unlink this file. SQLite releases its OS lock when the holder exits. */
export async function acquireServerOwnershipLock(directory: string) {
  await NodeFSP.mkdir(directory, { recursive: true });
  const stateDir = await NodeFSP.realpath(directory);
  const lockPath = NodePath.join(stateDir, "server-owner.sqlite");
  let db: { exec: (sql: string) => unknown; close: () => void };
  if (process.versions.bun) {
    // Keep Bun's runtime-only module out of the Node build's module resolver.
    const moduleName = "bun:sqlite";
    const sqlite: { Database: new (filename: string) => typeof db } = await import(moduleName);
    db = new sqlite.Database(lockPath);
  } else {
    db = new (await import("node:sqlite")).DatabaseSync(lockPath);
  }
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (cause) {
    db.close();
    throw cause;
  }
  return { stateDir, close: () => db.close() };
}
