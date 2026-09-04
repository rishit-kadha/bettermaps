import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { navigationManager } from "../../core/state/NavigationManager";
import { ActiveRoute } from "../../core/types/navigation";
import { useTheme } from "../../theme/ThemeContext";

interface RoutePreviewCardProps {
  route: ActiveRoute;
  onStart: () => void;
  onCancel: () => void;
}

export const RoutePreviewCard: React.FC<RoutePreviewCardProps> = ({
  route,
  onStart,
  onCancel,
}) => {
  const insets = useSafeAreaInsets();
  const { theme, mode } = useTheme();
  const { metadata } = route;

  const durationMin = Math.round(metadata.totalDurationSeconds / 60);
  const distanceKm = (metadata.totalDistanceMeters / 1000).toFixed(1);

  return (
    <View
      style={[
        styles.container,
        {
          bottom: Math.max(insets.bottom, 16) + 4,
          backgroundColor: theme.surface,
          borderColor: theme.surfaceBorder,
        },
      ]}
    >
      {/* Destination Header */}
      <View style={styles.headerRow}>
        <View style={styles.titleGroup}>
          <Text
            style={[styles.destinationName, { color: theme.textPrimary }]}
            numberOfLines={1}
          >
            {metadata.destinationName}
          </Text>
          {metadata.destinationAddress ? (
            <Text
              style={[
                styles.destinationAddress,
                { color: theme.textSecondary },
              ]}
              numberOfLines={1}
            >
              {metadata.destinationAddress}
            </Text>
          ) : null}
        </View>

        <TouchableOpacity
          style={styles.closeButton}
          onPress={onCancel}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="close" size={22} color={theme.textMuted} />
        </TouchableOpacity>
      </View>

      <View
        style={[styles.divider, { backgroundColor: theme.surfaceBorder }]}
      />

      {/* Metrics Row */}
      <View style={styles.metricsRow}>
        <View style={styles.timeGroup}>
          <Text style={styles.durationNumber}>{durationMin}</Text>
          <Text style={styles.durationUnit}>min</Text>
          <Text style={[styles.bulletPoint, { color: theme.textMuted }]}>
            •
          </Text>
          <Text style={[styles.distanceText, { color: theme.textSecondary }]}>
            {distanceKm} km
          </Text>
        </View>

        <View
          style={[
            styles.routeTag,
            {
              backgroundColor: mode === "dark" ? "#163321" : "#E6F4EA",
            },
          ]}
        >
          <Ionicons name="car-outline" size={14} color="#188038" />
          <Text style={styles.routeTagText}>Fastest route</Text>
        </View>
      </View>

      {/* Action Buttons */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.startButton, { backgroundColor: theme.accent }]}
          onPress={onStart}
          activeOpacity={0.85}
        >
          <Ionicons
            name="navigate"
            size={20}
            color="#FFFFFF"
            style={styles.navIcon}
          />
          <Text style={styles.startButtonText}>Start navigation</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 20,
    left: 16,
    right: 16,
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    padding: 18,
    elevation: 10,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    borderWidth: 1,
    borderColor: "#E8EAED",
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  titleGroup: {
    flex: 1,
    marginRight: 12,
  },
  destinationName: {
    fontSize: 18,
    fontWeight: "700",
    color: "#202124",
  },
  destinationAddress: {
    fontSize: 13,
    color: "#5F6368",
    marginTop: 2,
  },
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  divider: {
    height: 1,
    backgroundColor: "#F1F3F4",
    marginVertical: 12,
  },
  metricsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  timeGroup: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
  },
  durationNumber: {
    fontSize: 26,
    fontWeight: "800",
    color: "#188038", // Google Navigation Green
  },
  durationUnit: {
    fontSize: 14,
    fontWeight: "700",
    color: "#188038",
  },
  bulletPoint: {
    fontSize: 16,
    color: "#70757A",
    marginHorizontal: 4,
  },
  distanceText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#5F6368",
  },
  routeTag: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#E6F4EA",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 4,
  },
  routeTagText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#188038",
  },
  actionRow: {
    flexDirection: "row",
  },
  startButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1A73E8",
    paddingVertical: 14,
    borderRadius: 14,
    elevation: 3,
    shadowColor: "#1A73E8",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  navIcon: {
    marginRight: 8,
  },
  startButtonText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#FFFFFF",
    letterSpacing: 0.3,
  },
});
