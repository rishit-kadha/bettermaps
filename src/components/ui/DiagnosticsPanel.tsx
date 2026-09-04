import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NavigationTelemetry } from "../../core/types/navigation";
import { useTheme } from "../../theme/ThemeContext";

interface DiagnosticsPanelProps {
  telemetry: NavigationTelemetry;
  visible: boolean;
  onClose: () => void;
}

/**
 * DiagnosticsPanel
 *
 * Debug telemetry panel providing real-time positioning metrics:
 * - Update Frequency in approximate Hz (calculated via rolling window)
 * - Horizontal Accuracy radius (±m)
 * - Vehicle Speed (km/h and m/s)
 * - Course Heading & Reliability flag
 * - WGS84 Latitude, Longitude, Altitude
 * - Active Platform Provider tag (GNSS vs Future IDR)
 */
export const DiagnosticsPanel: React.FC<DiagnosticsPanelProps> = ({
  telemetry,
  visible,
  onClose,
}) => {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  if (!visible) return null;

  const {
    currentLocation,
    speedKmh,
    smoothedHeading,
    isHeadingReliable,
    updateFrequencyHz,
    providerName,
    providerType,
    providerStatus,
  } = telemetry;

  const latText = currentLocation
    ? `${currentLocation.latitude.toFixed(6)}°`
    : "--";
  const lngText = currentLocation
    ? `${currentLocation.longitude.toFixed(6)}°`
    : "--";
  const altText =
    currentLocation?.altitude !== null &&
    currentLocation?.altitude !== undefined
      ? `${currentLocation.altitude.toFixed(1)} m`
      : "--";
  const accText =
    currentLocation?.accuracy !== null &&
    currentLocation?.accuracy !== undefined
      ? `±${currentLocation.accuracy.toFixed(1)} m`
      : "--";
  const speedMsText =
    currentLocation?.speed !== null && currentLocation?.speed !== undefined
      ? `${currentLocation.speed.toFixed(1)} m/s`
      : "--";

  const formatTime = (epochMs?: number) => {
    if (!epochMs) return "--";
    const d = new Date(epochMs);
    return (
      d.toTimeString().split(" ")[0] +
      "." +
      String(d.getMilliseconds()).padStart(3, "0")
    );
  };

  return (
    <View
      style={[
        styles.container,
        {
          top: Math.max(insets.top, 16) + 124,
          right: 76,
          backgroundColor: theme.surface,
          borderColor: theme.surfaceBorder,
        },
      ]}
    >
      <View style={[styles.header, { borderBottomColor: theme.surfaceBorder }]}>
        <View style={styles.titleRow}>
          <View style={[styles.indicator, { backgroundColor: theme.accent }]} />
          <Text style={[styles.title, { color: theme.textPrimary }]}>
            GNSS DIAGNOSTICS
          </Text>
        </View>
        <TouchableOpacity
          onPress={onClose}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={[styles.closeTouch, { backgroundColor: theme.surfaceSubtle }]}
          accessibilityRole="button"
          accessibilityLabel="Close diagnostics"
        >
          <Text style={[styles.closeText, { color: theme.textPrimary }]}>
            ✕
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.grid}>
        {/* Row 1: Provider & Hz */}
        <View style={styles.row}>
          <View
            style={[
              styles.cell,
              {
                backgroundColor: theme.surfaceSubtle,
                borderColor: theme.surfaceBorder,
              },
            ]}
          >
            <Text style={[styles.label, { color: theme.textMuted }]}>
              PLATFORM PROVIDER
            </Text>
            <Text style={[styles.valueHighlight, { color: theme.textPrimary }]}>
              {providerType === "gnss" ? "GNSS" : providerType.toUpperCase()}
            </Text>
            <Text style={[styles.subText, { color: theme.textSecondary }]}>
              {providerName}
            </Text>
          </View>

          <View
            style={[
              styles.cell,
              {
                backgroundColor: theme.surfaceSubtle,
                borderColor: theme.surfaceBorder,
              },
            ]}
          >
            <Text style={[styles.label, { color: theme.textMuted }]}>
              UPDATE FREQ
            </Text>
            <Text
              style={[
                styles.valueHighlight,
                { color: updateFrequencyHz > 0 ? theme.success : theme.danger },
              ]}
            >
              ~{updateFrequencyHz.toFixed(1)} Hz
            </Text>
            <Text style={[styles.subText, { color: theme.textSecondary }]}>
              Target: ~10 Hz (IDR)
            </Text>
          </View>
        </View>

        {/* Row 2: Speed & Heading */}
        <View style={styles.row}>
          <View
            style={[
              styles.cell,
              {
                backgroundColor: theme.surfaceSubtle,
                borderColor: theme.surfaceBorder,
              },
            ]}
          >
            <Text style={[styles.label, { color: theme.textMuted }]}>
              GROUND SPEED
            </Text>
            <Text style={[styles.value, { color: theme.textPrimary }]}>
              {speedKmh}{" "}
              <Text style={[styles.unit, { color: theme.textSecondary }]}>
                km/h
              </Text>
            </Text>
            <Text style={[styles.subText, { color: theme.textSecondary }]}>
              ({speedMsText})
            </Text>
          </View>

          <View
            style={[
              styles.cell,
              {
                backgroundColor: theme.surfaceSubtle,
                borderColor: theme.surfaceBorder,
              },
            ]}
          >
            <Text style={[styles.label, { color: theme.textMuted }]}>
              COURSE HEADING
            </Text>
            <Text style={[styles.value, { color: theme.textPrimary }]}>
              {smoothedHeading}°
            </Text>
            <Text
              style={[
                styles.subText,
                { color: isHeadingReliable ? theme.success : theme.warning },
              ]}
            >
              {isHeadingReliable ? "Reliable (Moving)" : "Stationary / Inert"}
            </Text>
          </View>
        </View>

        {/* Row 3: Accuracy & Altitude */}
        <View style={styles.row}>
          <View
            style={[
              styles.cell,
              {
                backgroundColor: theme.surfaceSubtle,
                borderColor: theme.surfaceBorder,
              },
            ]}
          >
            <Text style={[styles.label, { color: theme.textMuted }]}>
              HORIZONTAL ACCURACY
            </Text>
            <Text style={[styles.value, { color: theme.accent }]}>
              {accText}
            </Text>
          </View>

          <View
            style={[
              styles.cell,
              {
                backgroundColor: theme.surfaceSubtle,
                borderColor: theme.surfaceBorder,
              },
            ]}
          >
            <Text style={[styles.label, { color: theme.textMuted }]}>
              ALTITUDE (WGS84)
            </Text>
            <Text style={[styles.value, { color: theme.textPrimary }]}>
              {altText}
            </Text>
          </View>
        </View>

        {/* Row 4: Coordinates */}
        <View
          style={[
            styles.coordsBox,
            {
              backgroundColor: theme.surfaceSubtle,
              borderColor: theme.surfaceBorder,
            },
          ]}
        >
          <View style={styles.coordCol}>
            <Text style={[styles.label, { color: theme.textMuted }]}>
              LATITUDE
            </Text>
            <Text style={[styles.coordValue, { color: theme.textPrimary }]}>
              {latText}
            </Text>
          </View>
          <View style={styles.coordCol}>
            <Text style={[styles.label, { color: theme.textMuted }]}>
              LONGITUDE
            </Text>
            <Text style={[styles.coordValue, { color: theme.textPrimary }]}>
              {lngText}
            </Text>
          </View>
        </View>

        {/* Footer */}
        <View style={styles.footerRow}>
          <Text style={[styles.footerText, { color: theme.textSecondary }]}>
            Gate:{" "}
            <Text
              style={[
                styles.boldText,
                {
                  color:
                    telemetry.gnssStreamGateState === "GNSS_STREAM_DISABLED"
                      ? theme.danger
                      : theme.success,
                },
              ]}
            >
              {telemetry.gnssStreamGateState === "GNSS_STREAM_DISABLED"
                ? "BLOCKED"
                : "ACTIVE"}
            </Text>{" "}
            • Engine:{" "}
            <Text style={[styles.boldText, { color: theme.textPrimary }]}>
              {telemetry.positioningStatus}
            </Text>
          </Text>
          <Text style={[styles.footerText, { color: theme.textSecondary }]}>
            Fix: {formatTime(currentLocation?.timestamp)}
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
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F3F4",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  indicator: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "#1A73E8",
    marginRight: 6,
  },
  title: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.8,
    color: "#3C4043",
  },
  closeTouch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: {
    fontSize: 15,
    fontWeight: "700",
  },
  grid: {
    gap: 8,
  },
  row: {
    flexDirection: "row",
    gap: 8,
  },
  cell: {
    flex: 1,
    backgroundColor: "#F8F9FA",
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: "#ECEFF1",
  },
  label: {
    fontSize: 9,
    fontWeight: "700",
    color: "#70757A",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  valueHighlight: {
    fontSize: 16,
    fontWeight: "800",
    color: "#202124",
  },
  value: {
    fontSize: 15,
    fontWeight: "700",
    color: "#202124",
  },
  unit: {
    fontSize: 10,
    fontWeight: "600",
    color: "#5F6368",
  },
  subText: {
    fontSize: 9,
    color: "#5F6368",
    marginTop: 2,
  },
  coordsBox: {
    flexDirection: "row",
    backgroundColor: "#F8F9FA",
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: "#ECEFF1",
  },
  coordCol: {
    flex: 1,
  },
  coordValue: {
    fontSize: 12,
    fontWeight: "700",
    fontFamily: "monospace",
    color: "#202124",
  },
  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 4,
  },
  footerText: {
    fontSize: 9,
    color: "#70757A",
  },
  boldText: {
    fontWeight: "700",
    color: "#202124",
  },
});
