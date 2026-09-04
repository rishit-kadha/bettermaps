import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ActiveRoute,
  LocationSourceTag,
  RouteProgress,
} from "../../core/types/navigation";
import { useTheme } from "../../theme/ThemeContext";

interface NavigationActiveHUDProps {
  route: ActiveRoute;
  progress: RouteProgress | null;
  speedKmh: number;
  heading: number;
  locationSource: LocationSourceTag;
  onExit: () => void;
}

export const NavigationActiveHUD: React.FC<NavigationActiveHUDProps> = ({
  route,
  progress,
  speedKmh,
  heading,
  locationSource,
  onExit,
}) => {
  const insets = useSafeAreaInsets();
  const { theme, mode } = useTheme();
  const remainingMin = progress
    ? Math.max(1, Math.round(progress.remainingDurationSeconds / 60))
    : Math.round(route.metadata.totalDurationSeconds / 60);

  const remainingKm = progress
    ? (progress.remainingDistanceMeters / 1000).toFixed(1)
    : (route.metadata.totalDistanceMeters / 1000).toFixed(1);

  const eta = progress?.etaClock || "--:--";

  const getSourceBadgeStyle = () => {
    const isDark = mode === "dark";
    switch (locationSource) {
      case "GNSS STREAM BLOCKED":
        return {
          bg: isDark ? "#381014" : "#FCE8E6",
          text: isDark ? "#F87171" : "#C5221F",
          label: "GNSS BLOCKED",
        };
      case "NO POSITION":
        return {
          bg: isDark ? "#21262D" : "#F1F3F4",
          text: isDark ? "#8B949E" : "#5F6368",
          label: "NO POSITION",
        };
      case "IDR":
        return {
          bg: isDark ? "#331E05" : "#FFE0B2",
          text: isDark ? "#FB923C" : "#E65100",
          label: "DEAD RECKONING",
        };
      case "GNSS+INS":
        return {
          bg: isDark ? "#2A153B" : "#E1BEE7",
          text: isDark ? "#C084FC" : "#6A1B9A",
          label: "GNSS + INS",
        };
      case "SIMULATOR":
        return {
          bg: isDark ? "#25173B" : "#EDE7F6",
          text: isDark ? "#A78BFA" : "#5E35B1",
          label: "SIMULATOR",
        };
      default:
        return {
          bg: isDark ? "#13331C" : "#E6F4EA",
          text: isDark ? "#4ADE80" : "#137333",
          label: "GNSS LIVE",
        };
    }
  };

  const badge = getSourceBadgeStyle();

  return (
    <View
      style={[styles.container, { bottom: Math.max(insets.bottom, 16) + 4 }]}
    >
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.surface,
            borderColor: theme.surfaceBorder,
          },
        ]}
      >
        {/* Left: ETA, Remaining Distance & Duration */}
        <View style={styles.progressCol}>
          <View style={styles.timeRow}>
            <Text style={styles.durationNum}>{remainingMin}</Text>
            <Text style={styles.durationUnit}>min</Text>
          </View>
          <View style={styles.subStatsRow}>
            <Text style={[styles.distanceText, { color: theme.textSecondary }]}>
              {remainingKm} km
            </Text>
            <Text style={[styles.dot, { color: theme.textMuted }]}>•</Text>
            <Text style={[styles.etaText, { color: theme.textSecondary }]}>
              {eta}
            </Text>
          </View>
        </View>

        {/* Center: Live Speed & Source Badge */}
        <View style={styles.centerCol}>
          <View style={styles.speedRow}>
            <Text style={[styles.speedNum, { color: theme.textPrimary }]}>
              {speedKmh}
            </Text>
            <Text style={[styles.speedUnit, { color: theme.textSecondary }]}>
              km/h
            </Text>
          </View>
          <View style={[styles.sourceBadge, { backgroundColor: badge.bg }]}>
            <Text style={[styles.sourceBadgeText, { color: badge.text }]}>
              {badge.label}
            </Text>
          </View>
        </View>

        {/* Right: Exit Navigation Button */}
        <TouchableOpacity
          style={[
            styles.exitButton,
            {
              backgroundColor: mode === "dark" ? "#381014" : "#FCE8E6",
            },
          ]}
          onPress={onExit}
          activeOpacity={0.8}
        >
          <Ionicons
            name="close"
            size={24}
            color={mode === "dark" ? "#F87171" : "#D93025"}
          />
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
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    paddingVertical: 14,
    paddingHorizontal: 18,
    elevation: 10,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    borderWidth: 1,
    borderColor: "#E8EAED",
  },
  progressCol: {
    flex: 1.2,
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "baseline",
  },
  durationNum: {
    fontSize: 28,
    fontWeight: "800",
    color: "#188038", // Google green
  },
  durationUnit: {
    fontSize: 14,
    fontWeight: "700",
    color: "#188038",
    marginLeft: 3,
  },
  subStatsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 2,
  },
  distanceText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#5F6368",
  },
  dot: {
    fontSize: 14,
    color: "#70757A",
    marginHorizontal: 5,
  },
  etaText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#5F6368",
  },
  centerCol: {
    flex: 1,
    alignItems: "center",
  },
  speedRow: {
    flexDirection: "row",
    alignItems: "baseline",
  },
  speedNum: {
    fontSize: 22,
    fontWeight: "800",
    color: "#202124",
  },
  speedUnit: {
    fontSize: 10,
    fontWeight: "700",
    color: "#5F6368",
    marginLeft: 2,
  },
  sourceBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginTop: 3,
  },
  sourceBadgeText: {
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  exitButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#FCE8E6",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },
});
