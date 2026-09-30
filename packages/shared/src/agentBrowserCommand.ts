const TARGET_OPTIONS = new Set([
  "--cdp",
  "--session",
  "--session-name",
  "--profile",
  "--config",
  "--provider",
  "-p",
  "--auto-connect",
  "--pin-tab",
  "--no-pin-tab",
  "--executable-path",
  "--args",
  "--headed",
  "--engine",
  "--proxy",
  "--proxy-bypass",
  "--proxy-username",
  "--proxy-password",
  "--extension",
  "--extensions",
  "--user-agent",
  "--stream-port",
  "--t3-tab",
  "--new-tab",
]);

const OUTPUT_FLAGS = new Set(["--json", "--debug", "--help", "-h"]);

/** Leading output flags do not change which browser command is being requested. */
export function getAgentBrowserCommandName(args: ReadonlyArray<string>): string | undefined {
  const command = args.find((arg) => !OUTPUT_FLAGS.has(arg));
  return command?.startsWith("-") ? undefined : command;
}

/** Managed commands stay bound to the tab chosen by T3's browser session. */
export function agentBrowserCommandError(args: ReadonlyArray<string>): string | null {
  if (args.length === 0 || args.length > 128 || args.join("").length > 65_536) {
    return "Provide a browser command with at most 128 arguments and 64 KiB of text.";
  }
  for (const arg of args) {
    if (TARGET_OPTIONS.has(arg.split("=", 1)[0]!)) {
      return "T3 supplies the browser, profile, and session. Call preview_open to select another tab.";
    }
  }
  const command = getAgentBrowserCommandName(args);
  if (command === undefined)
    return "Put the browser command before its options. Leading --json and --debug are supported.";
  if (
    [
      "connect",
      "session",
      "install",
      "close",
      "stream",
      "screencast_start",
      "screencast_stop",
      "dashboard",
      "mcp",
      "batch",
      "doctor",
      "chat",
    ].includes(command)
  ) {
    return "T3 manages browser sessions and streaming. Use preview_open for another tab.";
  }
  const commandArgs = args.filter((arg) => !OUTPUT_FLAGS.has(arg));
  if (
    command === "tab" &&
    !(commandArgs.length === 1 || (commandArgs.length === 2 && commandArgs[1] === "list"))
  ) {
    return "Use preview_open to create or select a T3 browser tab.";
  }
  return null;
}
