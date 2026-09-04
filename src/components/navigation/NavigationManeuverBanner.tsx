import React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ManeuverType, RouteProgress } from "../../core/types/navigation";
import { useTheme } from "../../theme/ThemeContext";

interface NavigationManeuverBannerProps {
  progress: RouteProgress | null;
  isArrived?: boolean;
}

export const NavigationManeuverBanner: React.FC<
  NavigationManeuverBannerProps
> = ({ progress, isArrived = false }) => {
  const insets = useSafeAreaInsets();
  const { mode } = useTheme();
  if (!progress) return null;

  const { distanceToManeuverMeters, nextManeuver } = progress;

  const formatDistance = (meters: number): string => {
    if (meters >= 1000) {
      return `In ${(meters / 1000).toFixed(1)} km`;
    }
    if (meters < 30) {
      return "Now";
    }
    // Round to nearest 50m
    const rounded = Math.round(meters / 50) * 50;
    return `In ${rounded} m`;
  };

  const getManeuverIcon = (
    type?: ManeuverType,
  ): keyof typeof Ionicons.glyphMap => {
    switch (type) {
      case "turn-left":
      case "turn-sharp-left":
        return "arrow-undo";
      case "turn-slight-left":
        return "arrow-up-left" as any;
      case "turn-right":
      case "turn-sharp-right":
        return "arrow-redo";
      case "turn-slight-right":
        return "arrow-up-right" as any;
      case "uturn":
        return "return-down-back";
      case "roundabout":
        return "sync";
      case "arrive":
        return "flag";
      default:
        return "arrow-up";
    }
  };

  const iconName = isArrived
    ? "flag"
    : getManeuverIcon(nextManeuver?.maneuverType);
  const distanceText = isArrived
    ? "You have arrived!"
    : formatDistance(distanceToManeuverMeters);
  const instructionText = isArrived
    ? "Destination reached"
    : nextManeuver?.instruction || "Continue on route";

  return (
    <View
      style={[
        styles.container,
        { top: Math.max(insets.top, Platform.OS === "android" ? 36 : 16) + 4 },
      ]}
      pointerEvents="box-none"
    >
      <View
        style={[
          styles.bannerCard,
          mode === "dark" && {
            backgroundColor: "#083B1B",
            borderWidth: 1,
            borderColor: "rgba(255, 255, 255, 0.15)",
          },
        ]}
      >
        <View style={styles.iconContainer}>
          <Ionicons name={iconName} size={32} color="#FFFFFF" />
        </View>

        <View style={styles.instructionContainer}>
          <Text style={styles.distanceText}>{distanceText}</Text>
          <Text style={styles.instructionText} numberOfLines={2}>
            {instructionText}
          </Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: Platform.OS === "ios" ? 54 : 36,
    left: 16,
    right: 16,
    zIndex: 90,
  },
  bannerCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0D652D", // High-contrast Google Navigation Green
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  instructionContainer: {
    flex: 1,
  },
  distanceText: {
    fontSize: 22,
    fontWeight: "800",
    color: "#FFFFFF",
    letterSpacing: 0.2,
  },
  instructionText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#E6F4EA",
    marginTop: 2,
    lineHeight: 20,
  },
});
