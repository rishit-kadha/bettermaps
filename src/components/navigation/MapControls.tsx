import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { NavigationMode } from "../../core/types/navigation";
import { useTheme } from "../../theme/ThemeContext";

interface MapControlsProps {
  mode: NavigationMode;
  cameraPerspective: "2D" | "3D";
  smoothedHeading: number;
  isSensorRecording: boolean;
  bottomOffset: number;
  isReplayActive?: boolean;
  onToggleReplay?: () => void;
  onOpenSensors?: () => void;
  onTogglePerspective: () => void;
  onToggleCompass: () => void;
  onRecenter: () => void;
}

/**
 * MapControls
 *
 * Floating action buttons on the right side of the map (Theme, Replay Lab, Sensors, 2D/3D, Compass, Recenter).
 * Operates in its own dedicated positioning context, completely independent from top search and bottom HUD.
 */
export const MapControls: React.FC<MapControlsProps> = ({
  mode,
  cameraPerspective,
  smoothedHeading,
  isSensorRecording,
  bottomOffset,
  isReplayActive = false,
  onToggleReplay,
  onOpenSensors,
  onTogglePerspective,
  onToggleCompass,
  onRecenter,
}) => {
  const { theme, mode: themeMode, toggleTheme } = useTheme();
  const isFreeMode = mode === "free";

  return (
    <View
      pointerEvents="box-none"
      style={[styles.container, { bottom: bottomOffset }]}
    >
      {/* 1. Theme Toggle FAB (Sun/Moon) */}
      <TouchableOpacity
        style={[
          styles.circleFab,
          {
            backgroundColor: theme.surface,
            borderColor: theme.surfaceBorder,
          },
        ]}
        onPress={toggleTheme}
        activeOpacity={0.8}
        accessibilityLabel={`Switch to ${themeMode === "dark" ? "light" : "dark"} theme`}
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      >
        <Ionicons
          name={themeMode === "dark" ? "sunny-outline" : "moon-outline"}
          size={20}
          color={themeMode === "dark" ? "#FDB813" : theme.textPrimary}
        />
      </TouchableOpacity>

      {/* 2. IO-VNBD Replay Lab FAB (hidden while Replay Lab is actively open to avoid control crowding) */}
      {onToggleReplay && !isReplayActive && (
        <TouchableOpacity
          style={[
            styles.circleFab,
            {
              backgroundColor: theme.surface,
              borderColor: theme.surfaceBorder,
            },
          ]}
          onPress={onToggleReplay}
          activeOpacity={0.8}
          accessibilityLabel="Open IO-VNBD Replay Lab"
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        >
          <Ionicons name="videocam-outline" size={20} color={theme.accent} />
        </TouchableOpacity>
      )}

      {/* 3. Sensors & Recorder FAB */}
      {onOpenSensors && (
        <TouchableOpacity
          style={[
            styles.circleFab,
            {
              backgroundColor: theme.surface,
              borderColor: theme.surfaceBorder,
            },
            isSensorRecording &&
              (themeMode === "dark"
                ? styles.sensorFabRecordingDark
                : styles.sensorFabRecording),
          ]}
          onPress={onOpenSensors}
          activeOpacity={0.8}
          accessibilityLabel="Open sensor telemetry lab"
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        >
          <Ionicons
            name={
              isSensorRecording ? "radio-button-on" : "hardware-chip-outline"
            }
            size={20}
            color={isSensorRecording ? theme.danger : theme.textPrimary}
          />
        </TouchableOpacity>
      )}

      {/* 3. Camera Perspective 2D / 3D Toggle */}
      <TouchableOpacity
        style={[
          styles.circleFab,
          {
            backgroundColor: theme.surface,
            borderColor: theme.surfaceBorder,
          },
          cameraPerspective === "3D" &&
            (themeMode === "dark"
              ? styles.perspectiveFab3DDark
              : styles.perspectiveFab3D),
        ]}
        onPress={onTogglePerspective}
        activeOpacity={0.8}
        accessibilityLabel={`Camera perspective: ${cameraPerspective}`}
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      >
        <Text
          style={[
            styles.perspectiveText,
            { color: theme.textPrimary },
            cameraPerspective === "3D" && styles.perspectiveText3D,
          ]}
        >
          {cameraPerspective}
        </Text>
      </TouchableOpacity>

      {/* 4. Compass Needle Button */}
      <TouchableOpacity
        style={[
          styles.circleFab,
          {
            backgroundColor: theme.surface,
            borderColor: theme.surfaceBorder,
          },
        ]}
        onPress={onToggleCompass}
        activeOpacity={0.8}
        accessibilityLabel="Rotate map to heading or north"
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      >
        <View
          style={[
            styles.compassNeedleContainer,
            {
              transform: [
                {
                  rotate: `${mode === "follow_course" ? 0 : 360 - smoothedHeading}deg`,
                },
              ],
            },
          ]}
        >
          <View style={styles.compassNorth} />
          <View style={styles.compassSouth} />
        </View>
      </TouchableOpacity>

      {/* 5. Recenter FAB */}
      <TouchableOpacity
        style={[
          styles.circleFab,
          {
            backgroundColor: isFreeMode ? theme.accent : theme.surface,
            borderColor: isFreeMode ? theme.accent : theme.surfaceBorder,
          },
          isFreeMode && styles.recenterActiveFab,
        ]}
        onPress={onRecenter}
        activeOpacity={0.8}
        accessibilityLabel={
          isFreeMode ? "Recenter vehicle on map" : "Vehicle centered"
        }
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      >
        {isFreeMode ? (
          <View style={styles.recenterInner}>
            <View style={styles.recenterIconFreeOuter}>
              <View style={styles.recenterIconFreeInner} />
            </View>
            <Text style={styles.recenterText}>Recenter</Text>
          </View>
        ) : (
          <View style={styles.recenterIconLocked}>
            <View
              style={[styles.crosshairH, { backgroundColor: theme.accent }]}
            />
            <View
              style={[styles.crosshairV, { backgroundColor: theme.accent }]}
            />
            <View
              style={[
                styles.crosshairCenterDot,
                {
                  borderColor: theme.accent,
                  backgroundColor: theme.surface,
                },
              ]}
            />
          </View>
        )}
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    right: 16,
    alignItems: "flex-end",
    gap: 12,
    zIndex: 60,
  },
  circleFab: {
    borderRadius: 24,
    minWidth: 48,
    height: 48,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
    elevation: 5,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    borderWidth: 1,
  },
  sensorFabRecording: {
    backgroundColor: "#FCE8E6",
    borderColor: "#D93025",
    borderWidth: 1.5,
  },
  sensorFabRecordingDark: {
    backgroundColor: "#381014",
    borderColor: "#F85149",
    borderWidth: 1.5,
  },
  perspectiveFab3D: {
    backgroundColor: "#E8F0FE",
    borderColor: "#1A73E8",
  },
  perspectiveFab3DDark: {
    backgroundColor: "#162947",
    borderColor: "#388BFD",
  },
  perspectiveText: {
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  perspectiveText3D: {
    color: "#1A73E8",
  },
  recenterActiveFab: {
    flexDirection: "row",
    paddingHorizontal: 14,
  },
  recenterInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  recenterText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
  },
  recenterIconFreeOuter: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  recenterIconFreeInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#FFFFFF",
  },
  recenterIconLocked: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  crosshairH: {
    position: "absolute",
    width: 16,
    height: 2,
  },
  crosshairV: {
    position: "absolute",
    width: 2,
    height: 16,
  },
  crosshairCenterDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 2,
  },
  compassNeedleContainer: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  compassNorth: {
    width: 0,
    height: 0,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderBottomWidth: 10,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: "#EA4335",
  },
  compassSouth: {
    width: 0,
    height: 0,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderTopWidth: 10,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: "#80868B",
  },
});
