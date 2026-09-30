import { describe, expect, it } from "vite-plus/test";

import { agentBrowserCommandError, getAgentBrowserCommandName } from "./agentBrowserCommand.ts";

describe("managed browser command targeting", () => {
  it("permits inspection, semantic interaction, diagnostics, and literal text", () => {
    for (const args of [
      ["snapshot", "-i", "--json"],
      ["fill", "@e1", "a quote ' and a dollar $ and a newline\n"],
      ["network", "requests", "--filter", "api"],
      ["profiler", "start"],
      ["skills", "get", "core", "--full"],
      ["tab", "list"],
      ["--json", "tab", "list"],
      ["--debug", "--json", "snapshot", "-i"],
    ])
      expect(agentBrowserCommandError(args)).toBeNull();
  });

  it("rejects selecting another runtime, profile, or session", () => {
    for (const args of [
      ["--cdp", "9222", "snapshot"],
      ["snapshot", "--session=other"],
      ["open", "https://example.com", "--auto-connect"],
      ["--profile", "/personal/chrome", "cookies"],
      ["tab", "new"],
      ["tab", "2"],
      ["connect", "9222"],
      ["close", "--all"],
      ["batch", "-"],
      ["--json", "tab", "new"],
      ["--debug", "--json", "close"],
      ["--json", "connect", "9222"],
      ["--unknown", "tab", "new"],
      ["click", "@e1", "--new-tab"],
      ["doctor"],
    ])
      expect(agentBrowserCommandError(args)).not.toBeNull();
  });

  it("identifies snapshots when output flags precede the command", () => {
    expect(getAgentBrowserCommandName(["--json", "--debug", "snapshot", "-i"])).toBe("snapshot");
    expect(getAgentBrowserCommandName(["--timeout", "1000", "snapshot"])).toBeUndefined();
  });
});
