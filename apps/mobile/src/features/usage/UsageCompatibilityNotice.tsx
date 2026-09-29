import { View } from "react-native";

import { EmptyState } from "../../components/EmptyState";
import type { usageAvailability } from "./usageAvailability";

export function UsageCompatibilityNotice({
  availability,
}: {
  readonly availability: ReturnType<typeof usageAvailability>;
}) {
  if (availability.notices.length === 0) return null;
  const detail = [
    ...availability.notices.map(({ message }) => message),
    availability.hasCompatibleSummary
      ? "Totals below only include compatible environments."
      : "Usage cannot be displayed until the app and server are compatible.",
  ].join("\n\n");
  return (
    <View accessible accessibilityRole="alert" accessibilityLiveRegion="polite">
      <EmptyState
        title={
          availability.hasCompatibleSummary ? "Some usage is unavailable" : "Usage unavailable"
        }
        detail={detail}
      />
    </View>
  );
}
