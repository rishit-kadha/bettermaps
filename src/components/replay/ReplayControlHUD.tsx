/**
 * ReplayControlHUD
 *
 * Developer Floating Panel & Replay Controls for Phase 4 Testing Harness.
 *
 * Provides:
 * - Transport controls: Play, Pause, Reset, Seek
 * - Speed multiplier pills (0.25x, 0.5x, 1x, 2x, 5x)
 * - Experiment Mode selector (C0, R0, R1, R2, R3)
 * - Diagnostic Leakage Counter: gnssMeasurementsDeliveredToEstimator
 * - Real-time quantitative error readout & milestone table (5s, 10s, 20s, 30s, 60s)
 * - Trajectory visibility toggles
 */

import React, { useState } from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ExperimentMode,
  ReplaySpeed,
  ReplayTelemetry,
} from "../../services/replay/types";
import { useTheme } from "../../theme/ThemeContext";

interface ReplayControlHUDProps {
  telemetry: ReplayTelemetry;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
  onSetSpeed: (speed: ReplaySpeed) => void;
  onSetMode: (mode: ExperimentMode) => void;
  onToggleRouteConstraint: () => void;
  onToggleReferenceVisible: () => void;
  onToggleEstimatedVisible: () => void;
  isReferenceVisible: boolean;
  isEstimatedVisible: boolean;
  onClose: () => void;
}

export const ReplayControlHUD: React.FC<ReplayControlHUDProps> = ({
  telemetry,
  onPlay,
  onPause,
  onReset,
  onSetSpeed,
  onSetMode,
  onToggleRouteConstraint,
  onToggleReferenceVisible,
  onToggleEstimatedVisible,
  isReferenceVisible,
  isEstimatedVisible,
  onClose,
}) => {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const [isExpanded, setIsExpanded] = useState(true);

  const formatMs = (ms: number): string => {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const tenths = Math.floor((ms % 1000) / 100);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenths}`;
  };

  const speedOptions: ReplaySpeed[] = [0.25, 0.5, 1.0, 2.0, 5.0];

  const experimentModes: { id: ExperimentMode; label: string }[] = [
    { id: "C0_REFERENCE_ONLY", label: "C0: Ref Control" },
    { id: "R0_PURE_DR", label: "R0: Pure DR" },
    { id: "R1_ROUTE_CONSTRAINED", label: "R1: Route Constr" },
    { id: "R2_FULL_GNSS", label: "R2: Full GNSS" },
    { id: "R3_DROP_RECOVERY", label: "R3: Drop/Recov" },
  ];

  const isPlaying = telemetry.clockState === "PLAYING";
  const progressPercent =
    telemetry.totalDurationMs > 0
      ? Math.min(
          100,
          (telemetry.elapsedTimeMs / telemetry.totalDurationMs) * 100,
        )
      : 0;

  return (
    <View
      style={[
        styles.container,
        {
          top: Math.max(insets.top, 16) + 8,
          backgroundColor: theme.surface,
          borderColor: theme.surfaceBorder,
        },
      ]}
    >
      {/* Top Header Bar */}
      <View style={[styles.header, { borderBottomColor: theme.surfaceBorder }]}>
        <View style={styles.headerLeft}>
          <View style={styles.sessionBadge}>
            <Text style={styles.sessionBadgeText}>IO-VNBD S1</Text>
          </View>
          <Text style={[styles.timeText, { color: theme.textPrimary }]}>
            {formatMs(telemetry.elapsedTimeMs)} /{" "}
            {formatMs(telemetry.totalDurationMs)}
          </Text>
        </View>

        <View style={styles.headerRight}>
          <TouchableOpacity
            onPress={() => setIsExpanded(!isExpanded)}
            style={[
              styles.iconButton,
              { backgroundColor: theme.surfaceSubtle },
            ]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={isExpanded ? "chevron-up" : "chevron-down"}
              size={18}
              color={theme.textPrimary}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onClose}
            style={[
              styles.iconButton,
              { backgroundColor: theme.surfaceSubtle, marginLeft: 6 },
            ]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="close" size={18} color={theme.textPrimary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Progress Bar Line */}
      <View style={styles.progressBarTrack}>
        <View
          style={[styles.progressBarFill, { width: `${progressPercent}%` }]}
        />
      </View>

      {/* Collapsible Body */}
      {isExpanded && (
        <View style={styles.scrollContent}>
          {/* 1. Transport Controls */}
          <View style={styles.transportRow}>
            <TouchableOpacity
              onPress={isPlaying ? onPause : onPlay}
              style={[
                styles.primaryTransportBtn,
                { backgroundColor: isPlaying ? "#FFA000" : "#4CAF50" },
              ]}
            >
              <Ionicons
                name={isPlaying ? "pause" : "play"}
                size={18}
                color="#FFFFFF"
              />
              <Text style={styles.primaryTransportText}>
                {isPlaying ? "PAUSE" : "PLAY"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={onReset}
              style={[
                styles.secondaryTransportBtn,
                { backgroundColor: theme.surfaceSubtle },
              ]}
            >
              <Ionicons name="reload" size={16} color={theme.textPrimary} />
              <Text
                style={[
                  styles.secondaryTransportText,
                  { color: theme.textPrimary },
                ]}
              >
                RESET
              </Text>
            </TouchableOpacity>

            {/* Speed Pills */}
            <View style={styles.speedRow}>
              {speedOptions.map((s) => (
                <TouchableOpacity
                  key={s}
                  onPress={() => onSetSpeed(s)}
                  style={[
                    styles.speedPill,
                    telemetry.speed === s
                      ? { backgroundColor: theme.accent }
                      : { backgroundColor: theme.surfaceSubtle },
                  ]}
                >
                  <Text
                    style={[
                      styles.speedPillText,
                      telemetry.speed === s
                        ? { color: "#FFFFFF" }
                        : { color: theme.textSecondary },
                    ]}
                  >
                    {s}x
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* 2. Experiment Mode Selector */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>
              EXPERIMENT MODE
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.modeScrollContent}
              keyboardShouldPersistTaps="always"
            >
              {experimentModes.map((m) => {
                const isSelected = telemetry.experimentMode === m.id;
                return (
                  <TouchableOpacity
                    key={m.id}
                    onPress={() => {
                      console.log("HUD onSetMode tapped:", m.id);
                      onSetMode(m.id);
                    }}
                    style={[
                      styles.modePill,
                      isSelected
                        ? {
                            backgroundColor: theme.accent,
                            borderColor: theme.accent,
                          }
                        : {
                            backgroundColor: theme.surfaceSubtle,
                            borderColor: theme.surfaceBorder,
                          },
                    ]}
                  >
                    <Text
                      style={[
                        styles.modePillText,
                        isSelected
                          ? { color: "#FFFFFF", fontWeight: "700" }
                          : { color: theme.textPrimary },
                      ]}
                    >
                      {m.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {/* 3. Real-Time Telemetry & Diagnostic Leakage Counter */}
          <View
            style={[
              styles.diagnosticCard,
              { backgroundColor: theme.surfaceSubtle },
            ]}
          >
            <View style={styles.diagnosticRow}>
              <View style={styles.diagCol}>
                <Text
                  style={[styles.diagLabel, { color: theme.textSecondary }]}
                >
                  GNSS TO ESTIMATOR
                </Text>
                <View style={styles.leakageBadge}>
                  <View
                    style={[
                      styles.leakageDot,
                      {
                        backgroundColor:
                          telemetry.gnssDeliveredCount === 0 &&
                          (telemetry.experimentMode === "R0_PURE_DR" ||
                            telemetry.experimentMode === "R1_ROUTE_CONSTRAINED")
                            ? "#4CAF50"
                            : telemetry.gnssPermittedIntoEstimator
                              ? "#2196F3"
                              : "#F44336",
                      },
                    ]}
                  />
                  <Text
                    style={[styles.diagValue, { color: theme.textPrimary }]}
                  >
                    {telemetry.gnssDeliveredCount} fixes
                  </Text>
                </View>
              </View>

              <View style={styles.diagCol}>
                <Text
                  style={[styles.diagLabel, { color: theme.textSecondary }]}
                >
                  POSITION ERROR
                </Text>
                <Text
                  style={[
                    styles.diagValue,
                    { color: "#FF9800", fontWeight: "800" },
                  ]}
                >
                  {telemetry.instantaneousErrorMeters !== null
                    ? `${telemetry.instantaneousErrorMeters.toFixed(1)} m`
                    : "--"}
                </Text>
              </View>

              <View style={styles.diagCol}>
                <Text
                  style={[styles.diagLabel, { color: theme.textSecondary }]}
                >
                  DRIFT RATIO
                </Text>
                <Text style={[styles.diagValue, { color: theme.textPrimary }]}>
                  {telemetry.cumulativeDriftPercent !== null
                    ? `${telemetry.cumulativeDriftPercent.toFixed(1)}%`
                    : "--"}
                </Text>
              </View>
            </View>
          </View>

          {/* 4. Milestone Checkpoint Table (5s, 10s, 20s, 30s, 60s) */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>
              ELAPSED TIME MILESTONES (ERROR)
            </Text>
            <View style={styles.milestoneRow}>
              <View
                style={[
                  styles.milestoneBox,
                  { backgroundColor: theme.surfaceSubtle },
                ]}
              >
                <Text style={styles.milestoneLabel}>5s</Text>
                <Text
                  style={[styles.milestoneVal, { color: theme.textPrimary }]}
                >
                  {telemetry.milestoneErrors.at5s !== null
                    ? `${telemetry.milestoneErrors.at5s}m`
                    : "--"}
                </Text>
              </View>
              <View
                style={[
                  styles.milestoneBox,
                  { backgroundColor: theme.surfaceSubtle },
                ]}
              >
                <Text style={styles.milestoneLabel}>10s</Text>
                <Text
                  style={[styles.milestoneVal, { color: theme.textPrimary }]}
                >
                  {telemetry.milestoneErrors.at10s !== null
                    ? `${telemetry.milestoneErrors.at10s}m`
                    : "--"}
                </Text>
              </View>
              <View
                style={[
                  styles.milestoneBox,
                  { backgroundColor: theme.surfaceSubtle },
                ]}
              >
                <Text style={styles.milestoneLabel}>20s</Text>
                <Text
                  style={[styles.milestoneVal, { color: theme.textPrimary }]}
                >
                  {telemetry.milestoneErrors.at20s !== null
                    ? `${telemetry.milestoneErrors.at20s}m`
                    : "--"}
                </Text>
              </View>
              <View
                style={[
                  styles.milestoneBox,
                  { backgroundColor: theme.surfaceSubtle },
                ]}
              >
                <Text style={styles.milestoneLabel}>30s</Text>
                <Text
                  style={[styles.milestoneVal, { color: theme.textPrimary }]}
                >
                  {telemetry.milestoneErrors.at30s !== null
                    ? `${telemetry.milestoneErrors.at30s}m`
                    : "--"}
                </Text>
              </View>
              <View
                style={[
                  styles.milestoneBox,
                  { backgroundColor: theme.surfaceSubtle },
                ]}
              >
                <Text style={styles.milestoneLabel}>60s</Text>
                <Text
                  style={[styles.milestoneVal, { color: theme.textPrimary }]}
                >
                  {telemetry.milestoneErrors.at60s !== null
                    ? `${telemetry.milestoneErrors.at60s}m`
                    : "--"}
                </Text>
              </View>
            </View>
          </View>

          {/* 5. Toggles Row */}
          <View style={styles.togglesRow}>
            <TouchableOpacity
              onPress={onToggleRouteConstraint}
              style={[
                styles.toggleButton,
                telemetry.routeConstraintActive
                  ? { backgroundColor: "#4CAF50" }
                  : { backgroundColor: theme.surfaceSubtle },
              ]}
            >
              <Ionicons
                name="git-commit"
                size={14}
                color={
                  telemetry.routeConstraintActive
                    ? "#FFFFFF"
                    : theme.textSecondary
                }
              />
              <Text
                style={[
                  styles.toggleText,
                  telemetry.routeConstraintActive
                    ? { color: "#FFFFFF", fontWeight: "700" }
                    : { color: theme.textSecondary },
                ]}
              >
                Route Constr
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={onToggleReferenceVisible}
              style={[
                styles.toggleButton,
                isReferenceVisible
                  ? { backgroundColor: "#00BCD4" }
                  : { backgroundColor: theme.surfaceSubtle },
              ]}
            >
              <Ionicons
                name="eye"
                size={14}
                color={isReferenceVisible ? "#FFFFFF" : theme.textSecondary}
              />
              <Text
                style={[
                  styles.toggleText,
                  isReferenceVisible
                    ? { color: "#FFFFFF", fontWeight: "700" }
                    : { color: theme.textSecondary },
                ]}
              >
                Reference
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={onToggleEstimatedVisible}
              style={[
                styles.toggleButton,
                isEstimatedVisible
                  ? { backgroundColor: "#FFA000" }
                  : { backgroundColor: theme.surfaceSubtle },
              ]}
            >
              <Ionicons
                name="navigate"
                size={14}
                color={isEstimatedVisible ? "#FFFFFF" : theme.textSecondary}
              />
              <Text
                style={[
                  styles.toggleText,
                  isEstimatedVisible
                    ? { color: "#FFFFFF", fontWeight: "700" }
                    : { color: theme.textSecondary },
                ]}
              >
                IDR Trace
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 12,
    right: 12,
    borderRadius: 16,
    borderWidth: 1,
    elevation: 12,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    zIndex: 99,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
  },
  sessionBadge: {
    backgroundColor: "#1A73E8",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginRight: 8,
  },
  sessionBadgeText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  timeText: {
    fontSize: 12,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  progressBarTrack: {
    height: 3,
    backgroundColor: "rgba(0,0,0,0.1)",
    width: "100%",
  },
  progressBarFill: {
    height: 3,
    backgroundColor: "#1A73E8",
  },
  scrollBody: {
    maxHeight: 280,
  },
  scrollContent: {
    padding: 12,
  },
  transportRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  primaryTransportBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    marginRight: 6,
  },
  primaryTransportText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "800",
    marginLeft: 4,
  },
  secondaryTransportBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    marginRight: 8,
  },
  secondaryTransportText: {
    fontSize: 11,
    fontWeight: "700",
    marginLeft: 4,
  },
  speedRow: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    justifyContent: "flex-end",
  },
  speedPill: {
    paddingHorizontal: 6,
    paddingVertical: 5,
    borderRadius: 6,
    marginLeft: 3,
  },
  speedPillText: {
    fontSize: 10,
    fontWeight: "700",
  },
  section: {
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  modeScrollContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 2,
  },
  modePill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    marginRight: 6,
  },
  modePillText: {
    fontSize: 11,
  },
  diagnosticCard: {
    borderRadius: 10,
    padding: 8,
    marginBottom: 8,
  },
  diagnosticRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  diagCol: {
    flex: 1,
    alignItems: "center",
  },
  diagLabel: {
    fontSize: 8,
    fontWeight: "700",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  diagValue: {
    fontSize: 12,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  leakageBadge: {
    flexDirection: "row",
    alignItems: "center",
  },
  leakageDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
  milestoneRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  milestoneBox: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 4,
    marginHorizontal: 2,
    borderRadius: 6,
  },
  milestoneLabel: {
    fontSize: 8,
    color: "#888",
    fontWeight: "700",
  },
  milestoneVal: {
    fontSize: 10,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  togglesRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  toggleButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    flex: 1,
    marginHorizontal: 3,
  },
  toggleText: {
    fontSize: 10,
    marginLeft: 4,
  },
});
