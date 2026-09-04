import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RoutePoint, NavigationTelemetry } from "../../core/types/navigation";
import { DestinationSearchBar } from "./DestinationSearchBar";
import { useTheme } from "../../theme/ThemeContext";

interface TopHeaderStackProps {
  currentLocation: RoutePoint | null;
  telemetry: NavigationTelemetry;
  diagnosticsOpen: boolean;
  isSensorRecording?: boolean;
  onToggleDiagnostics: () => void;
  onSwitchProvider: () => void;
  onOpenSensors?: () => void;
}

/**
 * TopHeaderStack
 *
 * Dedicated top overlay container that houses:
 * 1. Destination Search Bar ("Where to?")
 * 2. Clean Single-Row Action Pills:
 *    - [ Diagnostics / Close Stats ]
 *    - [ Live GNSS / Simulator ]
 *
 * Sensors and GNSS 3D Fix pills are removed to eliminate redundancy with FABs and stats card.
 */
export const TopHeaderStack: React.FC<TopHeaderStackProps> = ({
  currentLocation,
  telemetry,
  diagnosticsOpen,
  onToggleDiagnostics,
  onSwitchProvider,
}) => {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();

  const { providerType } = telemetry;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.container, { top: Math.max(insets.top, 16) + 8 }]}
    >
      {/* 1. Destination Search Bar */}
      <DestinationSearchBar currentLocation={currentLocation} />

      {/* 2. Single Responsive Row Action Pills */}
      <View pointerEvents="box-none" style={styles.pillsRow}>
        {/* Action Pill 1: Diagnostics */}
        <TouchableOpacity
          style={[
            styles.actionPill,
            {
              backgroundColor: diagnosticsOpen ? theme.accent : theme.surface,
              borderColor: diagnosticsOpen ? theme.accent : theme.surfaceBorder,
            },
          ]}
          onPress={onToggleDiagnostics}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          accessibilityRole="button"
          accessibilityLabel="Toggle diagnostics statistics"
        >
          <Ionicons
            name={diagnosticsOpen ? "stats-chart" : "stats-chart-outline"}
            size={15}
            color={diagnosticsOpen ? "#FFFFFF" : theme.accent}
            style={styles.pillIcon}
          />
          <Text
            style={[
              styles.actionPillText,
              {
                color: diagnosticsOpen ? "#FFFFFF" : theme.textPrimary,
              },
            ]}
          >
            {diagnosticsOpen ? "Close Stats" : "Diagnostics"}
          </Text>
        </TouchableOpacity>

        {/* Action Pill 2: Provider Switcher (Live GNSS / Simulator) */}
        <TouchableOpacity
          style={[
            styles.actionPill,
            {
              backgroundColor: theme.surface,
              borderColor: theme.surfaceBorder,
            },
          ]}
          onPress={onSwitchProvider}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          accessibilityRole="button"
          accessibilityLabel="Switch positioning provider"
        >
          <Ionicons
            name={
              providerType === "gnss"
                ? "navigate-circle-outline"
                : "game-controller-outline"
            }
            size={16}
            color={providerType === "gnss" ? "#137333" : "#9334E6"}
            style={styles.pillIcon}
          />
          <Text style={[styles.actionPillText, { color: theme.textPrimary }]}>
            {providerType === "gnss" ? "Live GNSS" : "Simulator"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 100,
  },
  pillsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    gap: 8,
  },
  actionPill: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    borderWidth: 1,
  },
  pillIcon: {
    marginRight: 6,
  },
  actionPillText: {
    fontSize: 12,
    fontWeight: "700",
  },
});
