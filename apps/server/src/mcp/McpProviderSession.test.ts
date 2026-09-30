import { describe, expect, it } from "vite-plus/test";
import { withAgentToolEnvironment } from "./McpProviderSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentToolEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentToolEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentToolEnvironment(environment, {})).toBe(environment);
  });

  it("routes browser-only sessions and composes browser and device launchers", () => {
    const base = { PATH: "/provider/bin", PROVIDER_KEY: "fixture" };
    const agentBrowserEnvironment = {
      PATH: "/t3/browser/bin",
      PATH_SEPARATOR: ":",
      T3_AGENT_BROWSER_CONFIG: "/t3/browser/session.json",
    };
    expect(withAgentToolEnvironment(base, { agentBrowserEnvironment })).toEqual({
      PATH: "/t3/browser/bin:/provider/bin",
      PROVIDER_KEY: "fixture",
      T3_AGENT_BROWSER_CONFIG: "/t3/browser/session.json",
    });
    expect(
      withAgentToolEnvironment(base, {
        agentBrowserEnvironment,
        agentDeviceEnvironment: { PATH: "/t3/device/bin", PATH_SEPARATOR: ":" },
      }).PATH,
    ).toBe("/t3/browser/bin:/t3/device/bin:/provider/bin");
    expect(base.PATH).toBe("/provider/bin");
  });

  it("never inherits an ancestor session's browser credential", () => {
    const base = {
      PATH: "/ancestor/browser/bin:/usr/bin",
      T3_AGENT_BROWSER_CONFIG: "/ancestor/credential.json",
      PROVIDER_KEY: "fixture",
    };
    for (const config of [undefined, {}, { agentDeviceEnvironment: { PATH: "/device/bin" } }]) {
      expect(withAgentToolEnvironment(base, config).T3_AGENT_BROWSER_CONFIG).toBeUndefined();
    }
    expect(
      withAgentToolEnvironment(base, {
        agentBrowserEnvironment: { T3_AGENT_BROWSER_CONFIG: "/current/credential.json" },
      }).T3_AGENT_BROWSER_CONFIG,
    ).toBe("/current/credential.json");
    expect(base.T3_AGENT_BROWSER_CONFIG).toBe("/ancestor/credential.json");
  });
});
