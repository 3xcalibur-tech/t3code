import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import { usageAvailability } from "./usageAvailability";

const mac = {
  environmentId: "mac" as EnvironmentId,
  label: "MacBook Pro",
  summary: {},
};
const newer = {
  environmentId: mac.environmentId,
  direction: "clientBehind" as const,
  contractVersion: 7,
};

describe("usageAvailability", () => {
  it("replaces all-incompatible totals with app-update instructions", () => {
    const result = usageAvailability([mac], [newer]);
    expect(result.hasCompatibleSummary).toBe(false);
    expect(result.notices[0]?.message).toContain("Update this app");
    expect(result.notices[0]?.message).toContain(mac.label);
  });

  it("directs users to the server when the server is too old", () => {
    const result = usageAvailability(
      [mac],
      [{ ...newer, direction: "serverBehind", contractVersion: 3 }],
    );
    expect(result.notices[0]?.message).toContain("Update the T3 Code server on MacBook Pro");
  });

  it("retains compatible summaries, including genuine zero usage", () => {
    expect(usageAvailability([mac], []).hasCompatibleSummary).toBe(true);
    const other = { ...mac, environmentId: "other" as EnvironmentId };
    expect(usageAvailability([mac, other], [newer]).hasCompatibleSummary).toBe(true);
    expect(
      usageAvailability([mac, { ...other, summary: null }], [newer]).hasCompatibleSummary,
    ).toBe(false);
  });

  it("clears notices once the versions are compatible", () => {
    expect(usageAvailability([mac], []).notices).toEqual([]);
  });
});
