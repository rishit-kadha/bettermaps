import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ProviderStatus } from "../../core/types/location";
import { useTheme } from "../../theme/ThemeContext";

interface SystemWarningBannerProps {
  providerStatus: ProviderStatus;
  isOutageActive: boolean;
  onRequestPermission: () => void;
  topOffset?: number;
}

export const SystemWarningBanner: React.FC<SystemWarningBannerProps> = ({
  providerStatus,
  isOutageActive,
  onRequestPermission,
  topOffset,
}) => {
  const insets = useSafeAreaInsets();
  const { mode: themeMode } = useTheme();

  const defaultTop = topOffset ?? Math.max(insets.top, 16) + 168;

  if (
    providerStatus !== "permission_denied" &&
    providerStatus !== "gnss_unavailable" &&
    !isOutageActive
  ) {
    return null;
  }

  return (
    <View
      pointerEvents="box-none"
      style={[styles.container, { top: defaultTop }]}
    >
      {/* 1. Location Permission Required */}
      {providerStatus === "permission_denied" && (
        <View
          style={[
            styles.warningBanner,
            {
              backgroundColor: themeMode === "dark" ? "#2D1E05" : "#FEF7E0",
              borderColor: themeMode === "dark" ? "#4D3308" : "#FEEFC3",
            },
          ]}
        >
          <View style={styles.warningContent}>
            <Text
              style={[
                styles.warningTitle,
                { color: themeMode === "dark" ? "#FBBF24" : "#B06000" },
              ]}
            >
              Location Permission Required
            </Text>
            <Text
              style={[
                styles.warningSubtitle,
                { color: themeMode === "dark" ? "#E2E8F0" : "#5F6368" },
              ]}
            >
              Saathi requires fine location access to track vehicle
              position.
            </Text>
          </View>
          <TouchableOpacity
            style={styles.grantButton}
            onPress={onRequestPermission}
            activeOpacity={0.8}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.grantButtonText}>Grant</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* 2. GPS Disabled */}
      {providerStatus === "gnss_unavailable" && (
        <View
          style={[
            styles.warningBanner,
            {
              backgroundColor: themeMode === "dark" ? "#2D1E05" : "#FEF7E0",
              borderColor: themeMode === "dark" ? "#4D3308" : "#FEEFC3",
            },
          ]}
        >
          <View style={styles.warningContent}>
            <Text
              style={[
                styles.warningTitle,
                { color: themeMode === "dark" ? "#FBBF24" : "#B06000" },
              ]}
            >
              Location Services Disabled
            </Text>
            <Text
              style={[
                styles.warningSubtitle,
                { color: themeMode === "dark" ? "#E2E8F0" : "#5F6368" },
              ]}
            >
              Please turn on GPS / Location in your Android device settings.
            </Text>
          </View>
        </View>
      )}

      {/* 3. GNSS Outage Simulation Active Banner */}
      {isOutageActive && (
        <View
          style={[
            styles.warningBanner,
            styles.outageBanner,
            {
              backgroundColor: themeMode === "dark" ? "#381014" : "#FCE8E6",
              borderColor: themeMode === "dark" ? "#5C1D24" : "#FAD2CF",
            },
          ]}
        >
          <View style={styles.warningContent}>
            <View style={styles.outageTitleRow}>
              <Ionicons name="radio-outline" size={16} color="#EA4335" />
              <Text
                style={[
                  styles.warningTitle,
                  styles.outageTitle,
                  { color: themeMode === "dark" ? "#F87171" : "#C5221F" },
                ]}
              >
                GNSS STREAM BLOCKED — SIMULATED OUTAGE
              </Text>
            </View>
            <Text
              style={[
                styles.warningSubtitle,
                { color: themeMode === "dark" ? "#E2E8F0" : "#5F6368" },
              ]}
            >
              Positioning Engine has zero GNSS input. Reference GNSS continues
              recording in background.
            </Text>
          </View>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 90,
  },
  warningBanner: {
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    borderWidth: 1,
  },
  warningContent: {
    flex: 1,
    marginRight: 10,
  },
  warningTitle: {
    fontSize: 13,
    fontWeight: "700",
  },
  outageBanner: {
    borderWidth: 1,
  },
  outageTitleRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  outageTitle: {
    marginLeft: 6,
  },
  warningSubtitle: {
    fontSize: 11,
    marginTop: 2,
  },
  grantButton: {
    backgroundColor: "#1A73E8",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
  },
  grantButtonText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
  },
});
