/**
 * ReplayControlHUD.tsx
 *
 * Clean, production-grade Replay Control HUD for BetterMaps SIH-Demo.
 *
 * Focused exclusively on the FINAL IDR production pipeline:
 * - Real-time virtual clock transport (Play / Pause / Reset)
 * - Fixed 1x playback pacing
 * - Production Pipeline Badge: FINAL IDR (GRU ✓ · ESKF ✓ · NHC ✓ · ROAD ✓ · ROUTE ✓)
 * - Real-time quantitative position error and SIH drift percentage
 * - Checkpoint milestone error & drift chips (5s, 10s, 20s, 30s, 60s)
 * - Visual map layer action buttons: [ Route ], [ Reference ], [ IDR Trace ], [ Roads ]
 * - Interactive Test Drive session picker (IO-VNBD S1, S2, Vta8, Vta10, Vtb4, Vtb10)
 */

import React, { useState } from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  EvaluationMode,
  ExperimentMode,
  ReplaySpeed,
  ReplayTelemetry,
} from "../../services/replay/types";
import { ModelBackendType } from "../../core/positioning/motionEstimator";
import { useTheme } from "../../theme/ThemeContext";
import { SessionPickerModal } from "./SessionPickerModal";

interface ReplayControlHUDProps {
  telemetry: ReplayTelemetry;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
  onSetSpeed?: (speed: ReplaySpeed) => void;
  onSetMode?: (mode: ExperimentMode) => void;
  onSelectEvaluationMode?: (mode: EvaluationMode) => void;
  onSelectModelBackend?: (backend: ModelBackendType) => void;
  onToggleRouteConstraint: () => void;
  onToggleReferenceVisible: () => void;
  onToggleEstimatedVisible: () => void;
  isReferenceVisible: boolean;
  isEstimatedVisible: boolean;
  isRoadLayerVisible?: boolean;
  onToggleRoadLayer?: () => void;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
}

export const ReplayControlHUD: React.FC<ReplayControlHUDProps> = ({
  telemetry,
  onPlay,
  onPause,
  onReset,
  onSetSpeed,
  onToggleRouteConstraint,
  onToggleReferenceVisible,
  onToggleEstimatedVisible,
  isReferenceVisible,
  isEstimatedVisible,
  isRoadLayerVisible = false,
  onToggleRoadLayer,
  onClose,
  onSelectSession,
}) => {
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useTheme();
  const [isExpanded, setIsExpanded] = useState(true);
  const [isSessionPickerOpen, setIsSessionPickerOpen] = useState(false);

  const safeNum = (
    val: number | null | undefined,
    digits = 1,
    fallback = "--",
    suffix = "",
  ): string => {
    if (
      val === null ||
      val === undefined ||
      typeof val !== "number" ||
      isNaN(val) ||
      !isFinite(val)
    ) {
      return fallback;
    }
    return `${val.toFixed(digits)}${suffix}`;
  };

  const formatMs = (ms: number | null | undefined): string => {
    if (
      ms === null ||
      ms === undefined ||
      typeof ms !== "number" ||
      isNaN(ms) ||
      !isFinite(ms)
    ) {
      return "00:00.0";
    }
    const safeMs = Math.max(0, ms);
    const totalSec = Math.floor(safeMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const tenths = Math.floor((safeMs % 1000) / 100);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenths}`;
  };

  const isPlaying = telemetry.clockState === "PLAYING";
  const progressPercent =
    telemetry.totalDurationMs &&
    telemetry.totalDurationMs > 0 &&
    typeof telemetry.elapsedTimeMs === "number"
      ? Math.max(
          0,
          Math.min(
            100,
            (telemetry.elapsedTimeMs / telemetry.totalDurationMs) * 100,
          ),
        )
      : 0;

  const rawSessionId = telemetry.sessionId || "S1";
  const cleanId = rawSessionId.replace(/^iovnbd_/i, "").toUpperCase();
  const displaySessionLabel = `IO-VNBD ${cleanId}`;

  const topOffset = Math.max(insets.top, 24) + 10;

  return (
    <>
      <View
        style={[
          styles.container,
          {
            top: topOffset,
            backgroundColor: theme.surface,
            borderColor: theme.surfaceBorder,
          },
        ]}
      >
        {/* Top Header Bar */}
        <View
          style={[styles.header, { borderBottomColor: theme.surfaceBorder }]}
        >
          <View style={styles.headerLeft}>
            {/* Interactive Test Drive Selector Badge */}
            <TouchableOpacity
              onPress={() => setIsSessionPickerOpen(true)}
              style={[styles.sessionBadge, { backgroundColor: theme.accent }]}
              activeOpacity={0.7}
              accessibilityLabel={`Select test drive session, current is ${displaySessionLabel}`}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <View style={styles.badgeContent}>
                <Text style={styles.sessionBadgeSub}>TEST DRIVE</Text>
                <View style={styles.badgeTitleRow}>
                  <Text style={styles.sessionBadgeText}>
                    {displaySessionLabel}
                  </Text>
                  <Ionicons
                    name="chevron-down"
                    size={12}
                    color="#FFFFFF"
                    style={{ marginLeft: 3 }}
                  />
                </View>
              </View>
            </TouchableOpacity>

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
              accessibilityLabel={
                isExpanded ? "Collapse Replay HUD" : "Expand Replay HUD"
              }
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
              accessibilityLabel="Close Replay Lab"
            >
              <Ionicons name="close" size={18} color={theme.textPrimary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Progress Bar Line */}
        <View style={styles.progressBarTrack}>
          <View
            style={[
              styles.progressBarFill,
              { width: `${progressPercent}%`, backgroundColor: theme.accent },
            ]}
          />
        </View>

        {/* Collapsible Body */}
        {isExpanded && (
          <View style={styles.bodyContent}>
            {/* Row 1: Transport Controls & Production Pipeline Badge */}
            <View style={styles.transportRow}>
              <TouchableOpacity
                onPress={isPlaying ? onPause : onPlay}
                style={[
                  styles.primaryTransportBtn,
                  { backgroundColor: isPlaying ? "#FFA000" : "#2E7D32" },
                ]}
                activeOpacity={0.8}
                accessibilityLabel={isPlaying ? "Pause replay" : "Play replay"}
              >
                <Ionicons
                  name={isPlaying ? "pause" : "play"}
                  size={15}
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
                  {
                    backgroundColor: theme.surfaceSubtle,
                    borderColor: theme.surfaceBorderSubtle,
                  },
                ]}
                activeOpacity={0.8}
                accessibilityLabel="Reset replay trajectory and timer"
              >
                <Ionicons name="reload" size={14} color={theme.textPrimary} />
                <Text
                  style={[
                    styles.secondaryTransportText,
                    { color: theme.textPrimary },
                  ]}
                >
                  RESET
                </Text>
              </TouchableOpacity>

              {/* Fixed 1x Speed Badge */}
              <View
                style={[
                  styles.speedBadge,
                  {
                    backgroundColor: theme.surfaceSubtle,
                    borderColor: theme.surfaceBorderSubtle,
                  },
                ]}
              >
                <Text style={[styles.speedBadgeText, { color: theme.textPrimary }]}>
                  1x
                </Text>
              </View>

              {/* FINAL IDR Pipeline Badge */}
              <View
                style={[
                  styles.pipelineBadge,
                  {
                    backgroundColor: isDark ? "#102318" : "#E8F5E9",
                    borderColor: isDark ? "#1B5E20" : "#C8E6C9",
                  },
                ]}
              >
                <Text style={[styles.pipelineTitle, { color: "#2E7D32" }]}>
                  FINAL IDR
                </Text>
                <Text style={[styles.pipelineChecks, { color: "#2E7D32" }]}>
                  GRU ✓ · ESKF ✓ · NHC ✓
                </Text>
              </View>
            </View>

            {/* Row 2: Real-time Quantitative Telemetry Card */}
            {/* Row 2: Real-time Quantitative Telemetry Card */}
            <View
              style={[
                styles.metricCard,
                {
                  backgroundColor: theme.surfaceSubtle,
                  borderColor: theme.surfaceBorderSubtle,
                },
              ]}
            >
              {/* Col 1: Mode & Position Source */}
              <View style={styles.metricCol}>
                <Text style={[styles.metricLabel, { color: theme.textSecondary }]}>
                  MODE & SOURCE
                </Text>
                <View style={styles.gnssStatusRow}>
                  <View
                    style={[
                      styles.gnssStatusDot,
                      {
                        backgroundColor: telemetry.isDeadReckoning
                          ? "#D32F2F"
                          : "#1976D2",
                      },
                    ]}
                  />
                  <Text
                    style={[
                      styles.metricVal,
                      {
                        color: telemetry.isDeadReckoning
                          ? "#D32F2F"
                          : "#1976D2",
                        fontWeight: "800",
                      },
                    ]}
                  >
                    {telemetry.isDeadReckoning ? "IDR (OUTAGE)" : "GNSS LOCKED"}
                  </Text>
                </View>
                <Text style={[styles.metricSub, { color: theme.textMuted }]}>
                  {telemetry.isDeadReckoning
                    ? "B3-GRU + 15-State ESKF"
                    : "Reference GNSS Anchor"}
                </Text>
              </View>

              {/* Col 2: Prominent SIH Outage Drift Card */}
              <View
                style={[
                  styles.metricCol,
                  styles.driftColHighlight,
                  {
                    backgroundColor:
                      telemetry.cumulativeDriftPercent !== null
                        ? telemetry.cumulativeDriftPercent <= 10.0
                          ? "rgba(46, 125, 50, 0.12)"
                          : "rgba(211, 47, 47, 0.12)"
                        : "transparent",
                    borderColor:
                      telemetry.cumulativeDriftPercent !== null
                        ? telemetry.cumulativeDriftPercent <= 10.0
                          ? "#2E7D32"
                          : "#D32F2F"
                        : "transparent",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.metricLabel,
                    {
                      color:
                        telemetry.cumulativeDriftPercent !== null
                          ? telemetry.cumulativeDriftPercent <= 10.0
                            ? "#2E7D32"
                            : "#D32F2F"
                          : theme.textSecondary,
                      fontWeight: "800",
                    },
                  ]}
                >
                  SIH OUTAGE DRIFT
                </Text>
                <Text
                  style={[
                    styles.metricValHighlight,
                    {
                      color:
                        telemetry.cumulativeDriftPercent !== null
                          ? telemetry.cumulativeDriftPercent <= 10.0
                            ? "#2E7D32"
                            : "#D32F2F"
                          : theme.textMuted,
                      fontSize: 18,
                      fontWeight: "900",
                    },
                  ]}
                >
                  {telemetry.cumulativeDriftPercent !== null
                    ? `${safeNum(telemetry.cumulativeDriftPercent, 1)}%`
                    : "N/A"}
                </Text>
                <Text
                  style={[
                    styles.metricSub,
                    {
                      color:
                        telemetry.cumulativeDriftPercent !== null
                          ? telemetry.cumulativeDriftPercent <= 10.0
                            ? "#2E7D32"
                            : "#D32F2F"
                          : theme.textMuted,
                      fontWeight: "700",
                    },
                  ]}
                >
                  {telemetry.cumulativeDriftPercent !== null
                    ? telemetry.cumulativeDriftPercent <= 10.0
                      ? "Target <10% (PASS ✓)"
                      : "Target <10% (ABOVE TARGET ✗)"
                    : "Outage Only"}
                </Text>
              </View>

              {/* Col 3: Endpoint Error & Outage Distance */}
              <View style={styles.metricCol}>
                <Text style={[styles.metricLabel, { color: theme.textSecondary }]}>
                  ENDPOINT ERROR
                </Text>
                <Text
                  style={[
                    styles.metricValHighlight,
                    { color: "#F57C00", fontWeight: "800" },
                  ]}
                >
                  {safeNum(telemetry.instantaneousErrorMeters, 1, "--", " m")}
                </Text>
                <Text style={[styles.metricSub, { color: theme.textMuted }]}>
                  Outage Dist: {safeNum(telemetry.cumulativeDistanceTraveledM, 0, "0", " m")}
                </Text>
              </View>
            </View>

            {/* Row 3: Elapsed Time Milestones (Errors & Drift %) */}
            <View style={styles.milestoneSection}>
              <View style={styles.milestoneHeaderRow}>
                <Text
                  style={[styles.sectionTitle, { color: theme.textSecondary }]}
                >
                  ELAPSED TIME MILESTONES (METERS & DRIFT %)
                </Text>
              </View>

              <View style={styles.milestonesGrid}>
                {(
                  [
                    {
                      label: "5s",
                      err: telemetry.milestoneErrors?.at5s,
                      drift: telemetry.milestoneDrifts?.at5s,
                    },
                    {
                      label: "10s",
                      err: telemetry.milestoneErrors?.at10s,
                      drift: telemetry.milestoneDrifts?.at10s,
                    },
                    {
                      label: "20s",
                      err: telemetry.milestoneErrors?.at20s,
                      drift: telemetry.milestoneDrifts?.at20s,
                    },
                    {
                      label: "30s",
                      err: telemetry.milestoneErrors?.at30s,
                      drift: telemetry.milestoneDrifts?.at30s,
                    },
                    {
                      label: "60s",
                      err: telemetry.milestoneErrors?.at60s,
                      drift: telemetry.milestoneDrifts?.at60s,
                    },
                  ] as const
                ).map((m) => (
                  <View
                    key={m.label}
                    style={[
                      styles.milestoneBox,
                      {
                        backgroundColor: theme.surfaceSubtle,
                        borderColor: theme.surfaceBorderSubtle,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.milestoneLabel,
                        { color: theme.textMuted },
                      ]}
                    >
                      {m.label}
                    </Text>
                    <Text
                      style={[
                        styles.milestoneMeters,
                        { color: theme.textPrimary },
                      ]}
                      numberOfLines={1}
                    >
                      {safeNum(m.err, 1, "--", "m")}
                    </Text>
                    <Text
                      style={[
                        styles.milestoneDrift,
                        { color: theme.accent },
                      ]}
                      numberOfLines={1}
                    >
                      {m.drift !== null && m.drift !== undefined
                        ? `${m.drift}%`
                        : "--"}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            {/* Row 4: Layer Action Toggles ([ Route ], [ Reference ], [ IDR Trace ], [ Roads ]) */}
            <View style={styles.togglesRow}>
              {/* 1. [ Route ] Toggle */}
              <TouchableOpacity
                onPress={onToggleRouteConstraint}
                style={[
                  styles.toggleBtn,
                  telemetry.routeConstraintActive
                    ? { backgroundColor: "#2E7D32", borderColor: "#2E7D32" }
                    : {
                        backgroundColor: theme.surfaceSubtle,
                        borderColor: theme.surfaceBorderSubtle,
                      },
                ]}
                activeOpacity={0.8}
                accessibilityLabel="Toggle Navigation Route Corridor"
              >
                <Ionicons
                  name="git-commit"
                  size={13}
                  color={
                    telemetry.routeConstraintActive
                      ? "#FFFFFF"
                      : theme.textSecondary
                  }
                />
                <Text
                  style={[
                    styles.toggleBtnText,
                    telemetry.routeConstraintActive
                      ? { color: "#FFFFFF", fontWeight: "700" }
                      : { color: theme.textSecondary },
                  ]}
                >
                  Route {telemetry.routeConstraintActive ? "✓" : ""}
                </Text>
              </TouchableOpacity>

              {/* 2. [ Reference ] Toggle */}
              <TouchableOpacity
                onPress={onToggleReferenceVisible}
                style={[
                  styles.toggleBtn,
                  isReferenceVisible
                    ? { backgroundColor: "#0097A7", borderColor: "#0097A7" }
                    : {
                        backgroundColor: theme.surfaceSubtle,
                        borderColor: theme.surfaceBorderSubtle,
                      },
                ]}
                activeOpacity={0.8}
                accessibilityLabel="Toggle Reference GPS Trajectory"
              >
                <Ionicons
                  name="eye"
                  size={13}
                  color={isReferenceVisible ? "#FFFFFF" : theme.textSecondary}
                />
                <Text
                  style={[
                    styles.toggleBtnText,
                    isReferenceVisible
                      ? { color: "#FFFFFF", fontWeight: "700" }
                      : { color: theme.textSecondary },
                  ]}
                >
                  Reference
                </Text>
              </TouchableOpacity>

              {/* 3. [ IDR Trace ] Toggle */}
              <TouchableOpacity
                onPress={onToggleEstimatedVisible}
                style={[
                  styles.toggleBtn,
                  isEstimatedVisible
                    ? { backgroundColor: "#F57C00", borderColor: "#F57C00" }
                    : {
                        backgroundColor: theme.surfaceSubtle,
                        borderColor: theme.surfaceBorderSubtle,
                      },
                ]}
                activeOpacity={0.8}
                accessibilityLabel="Toggle IDR Dead Reckoning Trajectory"
              >
                <Ionicons
                  name="navigate"
                  size={13}
                  color={isEstimatedVisible ? "#FFFFFF" : theme.textSecondary}
                />
                <Text
                  style={[
                    styles.toggleBtnText,
                    isEstimatedVisible
                      ? { color: "#FFFFFF", fontWeight: "700" }
                      : { color: theme.textSecondary },
                  ]}
                >
                  IDR Trace
                </Text>
              </TouchableOpacity>

              {/* 4. [ Roads ] Toggle */}
              {onToggleRoadLayer && (
                <TouchableOpacity
                  onPress={onToggleRoadLayer}
                  style={[
                    styles.toggleBtn,
                    isRoadLayerVisible
                      ? { backgroundColor: "#00E676", borderColor: "#00E676" }
                      : {
                          backgroundColor: theme.surfaceSubtle,
                          borderColor: theme.surfaceBorderSubtle,
                        },
                  ]}
                  activeOpacity={0.8}
                  accessibilityLabel="Toggle Real Road Network Geometry"
                >
                  <Ionicons
                    name="map"
                    size={13}
                    color={isRoadLayerVisible ? "#000000" : theme.textSecondary}
                  />
                  <Text
                    style={[
                      styles.toggleBtnText,
                      isRoadLayerVisible
                        ? { color: "#000000", fontWeight: "800" }
                        : { color: theme.textSecondary },
                    ]}
                  >
                    Roads
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}
      </View>

      {/* Dedicated Session Picker Modal Component */}
      <SessionPickerModal
        visible={isSessionPickerOpen}
        currentSessionId={telemetry.sessionId}
        onSelectSession={onSelectSession}
        onClose={() => setIsSessionPickerOpen(false)}
      />
    </>
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
    shadowOpacity: 0.28,
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
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
  },
  sessionBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 7,
    marginRight: 8,
    minHeight: 32,
    justifyContent: "center",
  },
  badgeContent: {
    justifyContent: "center",
  },
  sessionBadgeSub: {
    color: "rgba(255, 255, 255, 0.75)",
    fontSize: 7.5,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  badgeTitleRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  sessionBadgeText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "800",
  },
  timeText: {
    fontSize: 12,
    fontWeight: "700",
    fontFamily: "monospace",
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
    backgroundColor: "rgba(150, 150, 150, 0.2)",
    width: "100%",
  },
  progressBarFill: {
    height: "100%",
  },
  bodyContent: {
    padding: 10,
    gap: 8,
  },
  transportRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  primaryTransportBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    gap: 4,
  },
  primaryTransportText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  secondaryTransportBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
  },
  secondaryTransportText: {
    fontSize: 11,
    fontWeight: "700",
  },
  speedBadge: {
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  speedBadgeText: {
    fontSize: 11,
    fontWeight: "800",
  },
  pipelineBadge: {
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: "center",
  },
  pipelineTitle: {
    fontSize: 9.5,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  pipelineChecks: {
    fontSize: 8,
    fontWeight: "700",
    marginTop: 1,
  },
  metricCard: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 8,
    borderRadius: 10,
    borderWidth: 1,
    gap: 6,
  },
  metricCol: {
    flex: 1,
  },
  driftColHighlight: {
    padding: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  metricLabel: {
    fontSize: 8,
    fontWeight: "700",
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  metricVal: {
    fontSize: 12,
    fontWeight: "700",
  },
  metricValHighlight: {
    fontSize: 13.5,
    fontWeight: "800",
  },
  metricSub: {
    fontSize: 8,
    marginTop: 1,
  },
  gnssStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  gnssStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  milestoneSection: {
    gap: 4,
  },
  milestoneHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionTitle: {
    fontSize: 8.5,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  milestonesGrid: {
    flexDirection: "row",
    gap: 5,
  },
  milestoneBox: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 5,
    paddingHorizontal: 2,
    borderRadius: 8,
    borderWidth: 1,
  },
  milestoneLabel: {
    fontSize: 8,
    fontWeight: "700",
  },
  milestoneMeters: {
    fontSize: 10.5,
    fontWeight: "800",
    marginTop: 1,
  },
  milestoneDrift: {
    fontSize: 8.5,
    fontWeight: "700",
    marginTop: 1,
  },
  togglesRow: {
    flexDirection: "row",
    gap: 6,
  },
  toggleBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
  },
  toggleBtnText: {
    fontSize: 10,
    fontWeight: "700",
  },
});
