import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NavigationTelemetry } from "../../core/types/navigation";
import { useTheme } from "../../theme/ThemeContext";

interface BottomHUDProps {
  telemetry: NavigationTelemetry;
  visible?: boolean;
}

/**
 * BottomHUD
 *
 * Vehicle status and telemetry dock strictly anchored to the bottom of the map viewport.
 * Positioned independently with its own positioning context using safe-area insets.
 */
export const BottomHUD: React.FC<BottomHUDProps> = ({
  telemetry,
  visible = true,
}) => {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();

  if (!visible) {
    return null;
  }

  const {
    currentLocation,
    speedKmh,
    smoothedHeading,
    isHeadingReliable,
    gnssStreamGateState,
  } = telemetry;

  const isOutageActive = gnssStreamGateState === "GNSS_STREAM_DISABLED";

  const getCardinal = (deg: number): string => {
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const index = Math.round(deg / 45) % 8;
    return directions[index];
  };

  const accuracyText = isOutageActive
    ? "BLOCKED"
    : currentLocation?.accuracy !== null &&
        currentLocation?.accuracy !== undefined
      ? `±${currentLocation.accuracy.toFixed(1)}m`
      : "--";

  return (
    <View
      pointerEvents="box-none"
      style={[styles.container, { bottom: Math.max(insets.bottom, 12) + 6 }]}
    >
      <View
        style={[
          styles.telemetryCard,
          {
            backgroundColor: theme.surface,
            borderColor: theme.surfaceBorder,
          },
        ]}
      >
        {/* Speed Column */}
        <View style={styles.statCol}>
          <View style={styles.speedRow}>
            <Text style={[styles.speedNum, { color: theme.textPrimary }]}>
              {speedKmh}
            </Text>
            <Text style={[styles.speedUnit, { color: theme.textSecondary }]}>
              km/h
            </Text>
          </View>
          <Text style={[styles.statLabel, { color: theme.textMuted }]}>
            VEHICLE SPEED
          </Text>
        </View>

        <View
          style={[styles.vertDivider, { backgroundColor: theme.surfaceBorder }]}
        />

        {/* Heading Column */}
        <View style={styles.statCol}>
          <View style={styles.headingRow}>
            <Text style={[styles.headingNum, { color: theme.textPrimary }]}>
              {smoothedHeading}°
            </Text>
            <Text style={[styles.cardinalTag, { color: theme.accent }]}>
              {getCardinal(smoothedHeading)}
            </Text>
          </View>
          <Text style={[styles.statLabel, { color: theme.textMuted }]}>
            {isHeadingReliable ? "COURSE HEADING" : "BEARING"}
          </Text>
        </View>

        <View
          style={[styles.vertDivider, { backgroundColor: theme.surfaceBorder }]}
        />

        {/* Accuracy Column */}
        <View style={styles.statCol}>
          <Text
            style={[
              styles.accuracyNum,
              {
                color: isOutageActive ? theme.danger : theme.success,
              },
            ]}
          >
            {accuracyText}
          </Text>
          <Text style={[styles.statLabel, { color: theme.textMuted }]}>
            ACCURACY
          </Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 50,
  },
  telemetryCard: {
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    borderWidth: 1,
  },
  statCol: {
    flex: 1,
    alignItems: "center",
  },
  vertDivider: {
    width: 1,
    height: 36,
  },
  speedRow: {
    flexDirection: "row",
    alignItems: "baseline",
  },
  speedNum: {
    fontSize: 28,
    fontWeight: "800",
  },
  speedUnit: {
    fontSize: 11,
    fontWeight: "700",
    marginLeft: 3,
  },
  headingRow: {
    flexDirection: "row",
    alignItems: "baseline",
  },
  headingNum: {
    fontSize: 22,
    fontWeight: "700",
  },
  cardinalTag: {
    fontSize: 12,
    fontWeight: "800",
    marginLeft: 4,
  },
  accuracyNum: {
    fontSize: 18,
    fontWeight: "700",
  },
  statLabel: {
    fontSize: 9,
    fontWeight: "700",
    marginTop: 2,
    letterSpacing: 0.6,
  },
});
