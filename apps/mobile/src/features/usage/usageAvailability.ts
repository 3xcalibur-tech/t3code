import type { EnvironmentId } from "@t3tools/contracts";
import type { UsageContractMismatch } from "@t3tools/shared/usageMerge";

export function usageAvailability(
  environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly summary: unknown;
  }[],
  mismatches: readonly UsageContractMismatch[],
) {
  const incompatibleIds = new Set(mismatches.map(({ environmentId }) => environmentId));
  return {
    hasCompatibleSummary: environments.some(
      ({ environmentId, summary }) => summary != null && !incompatibleIds.has(environmentId),
    ),
    notices: mismatches.map((mismatch) => {
      const label =
        environments.find(({ environmentId }) => environmentId === mismatch.environmentId)?.label ??
        "this environment";
      return {
        environmentId: mismatch.environmentId,
        message:
          mismatch.direction === "clientBehind"
            ? `Update this app to see usage from ${label}. Its server uses a newer usage format.`
            : `Update the T3 Code server on ${label} to see its usage. Its usage format is too old for this app.`,
      };
    }),
  };
}
