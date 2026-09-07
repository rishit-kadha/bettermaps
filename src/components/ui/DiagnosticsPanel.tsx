/**
 * DiagnosticsPanel.tsx
 *
 * Professional bottom-sheet diagnostics modal for BetterMaps.
 * Displays real-time quantitative positioning telemetry structured into 6 scannable sections:
 * 1. POSITIONING (Provider, Speed, Heading, Accuracy, Reliability)
 * 2. AI MODEL (B3_GRU ONNX status, Inferences, Latency, Window, Predictions)
 * 3. ROAD COVERAGE (Mode, Region, Loaded Tiles, Cache Hits, Coalescing)
 * 4. REPLAY (Session ID, Clock, Drift %, Instantaneous Error, Milestones)
 * 5. GNSS & SENSOR FUSION (Raw GNSS vs ESKF Fused State, Fix Age, Fix Count)
 * 6. PERFORMANCE & MEMORY (Update Freq Hz, RAM Road Budget, Memory Pressure, Evictions)
 */

import React from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NavigationTelemetry } from "../../core/types/navigation";
import { ReplayTelemetry } from "../../services/replay/types";
import { useTheme } from "../../theme/ThemeContext";

interface DiagnosticsPanelProps {
  telemetry: NavigationTelemetry;
  replayTelemetry?: ReplayTelemetry;
  visible: boolean;
  onClose: () => void;
}

export const DiagnosticsPanel: React.FC<DiagnosticsPanelProps> = ({
  telemetry,
  replayTelemetry,
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
    locationSource,
    isDeadReckoning,
    gnssStatus,
    lastGnssFixAgeMs,
    gnssFixCount,
    eskfGnssUpdateCount,
    currentPositionEstimate,
    rawGnssLocation,
    gruModelDiagnostics,
    roadCoverageDiagnostics,
    roadMemoryDiagnostics,
    gnssStreamGateState,
    positioningStatus,
  } = telemetry;

  const latText = currentLocation
    ? `${currentLocation.latitude.toFixed(6)}°`
    : "--";
  const lngText = currentLocation
    ? `${currentLocation.longitude.toFixed(6)}°`
    : "--";
  const altText =
    currentLocation?.altitude !== null && currentLocation?.altitude !== undefined
      ? `${currentLocation.altitude.toFixed(1)} m`
      : "--";
  const accText =
    currentLocation?.accuracy !== null && currentLocation?.accuracy !== undefined
      ? `±${currentLocation.accuracy.toFixed(1)} m`
      : "--";
  const speedMsText =
    currentLocation?.speed !== null && currentLocation?.speed !== undefined
      ? `${currentLocation.speed.toFixed(1)} m/s`
      : "--";

  const formatMs = (ms: number | null | undefined): string => {
    if (ms === null || ms === undefined || isNaN(ms) || !isFinite(ms)) {
      return "00:00.0";
    }
    const safeMs = Math.max(0, ms);
    const totalSec = Math.floor(safeMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const tenths = Math.floor((safeMs % 1000) / 100);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenths}`;
  };

  const safeNum = (
    val: number | null | undefined,
    digits = 1,
    fallback = "--",
    suffix = "",
  ): string => {
    if (val === null || val === undefined || isNaN(val) || !isFinite(val)) {
      return fallback;
    }
    return `${val.toFixed(digits)}${suffix}`;
  };

  return (
    <View
      style={[
        styles.bottomSheet,
        {
          paddingBottom: Math.max(insets.bottom, 12),
          backgroundColor: theme.surface,
          borderColor: theme.surfaceBorder,
        },
      ]}
    >
      {/* 0. Top Drag Handle */}
      <View style={styles.dragHandleContainer}>
        <View
          style={[styles.dragHandle, { backgroundColor: theme.surfaceBorder }]}
        />
      </View>

      {/* Header Bar */}
      <View style={[styles.header, { borderBottomColor: theme.surfaceBorder }]}>
        <View style={styles.titleRow}>
          <View style={[styles.indicator, { backgroundColor: theme.accent }]} />
          <Text style={[styles.title, { color: theme.textPrimary }]}>
            GNSS & ESTIMATOR DIAGNOSTICS
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

      {/* Scrollable Structured Sections */}
      <ScrollView
        style={styles.scrollContainer}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ============================================================ */}
        {/* SECTION 1: POSITIONING                                       */}
        {/* ============================================================ */}
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.surfaceSubtle,
              borderColor: theme.surfaceBorder,
            },
          ]}
        >
          <View style={styles.cardHeader}>
            <Text style={[styles.cardTitle, { color: theme.accent }]}>
              1. POSITIONING & ESTIMATION
            </Text>
            <Text
              style={[
                styles.badge,
                {
                  color: isDeadReckoning ? theme.warning : theme.success,
                  borderColor: isDeadReckoning ? theme.warning : theme.success,
                },
              ]}
            >
              {locationSource}
            </Text>
          </View>

          <View style={styles.dataRow}>
            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                PROVIDER
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {providerType === "gnss" ? "GNSS" : providerType?.toUpperCase()}
              </Text>
              <Text style={[styles.sub, { color: theme.textSecondary }]}>
                {providerName}
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                GROUND SPEED
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {speedKmh}{" "}
                <Text style={[styles.unit, { color: theme.textSecondary }]}>
                  km/h
                </Text>
              </Text>
              <Text style={[styles.sub, { color: theme.textSecondary }]}>
                {speedMsText}
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                COURSE HEADING
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {smoothedHeading}°
              </Text>
              <Text
                style={[
                  styles.sub,
                  { color: isHeadingReliable ? theme.success : theme.warning },
                ]}
              >
                {isHeadingReliable ? "Moving" : "Stationary"}
              </Text>
            </View>
          </View>

          <View style={styles.dataRow}>
            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                HORIZONTAL ACCURACY
              </Text>
              <Text style={[styles.valHighlight, { color: theme.accent }]}>
                {accText}
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                ENGINE STATUS
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {positioningStatus}
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                IDR DR STATUS
              </Text>
              <Text
                style={[
                  styles.val,
                  {
                    color: isDeadReckoning ? theme.warning : theme.success,
                  },
                ]}
              >
                {isDeadReckoning ? "ACTIVE" : "INACTIVE"}
              </Text>
            </View>
          </View>
        </View>

        {/* ============================================================ */}
        {/* SECTION 2: AI MODEL (B3_GRU ONNX)                           */}
        {/* ============================================================ */}
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.surfaceSubtle,
              borderColor:
                gruModelDiagnostics?.status === "READY"
                  ? theme.success
                  : gruModelDiagnostics?.status === "LOADING"
                  ? theme.warning
                  : theme.surfaceBorder,
            },
          ]}
        >
          <View style={styles.cardHeader}>
            <Text style={[styles.cardTitle, { color: theme.accent }]}>
              2. AI MODEL (B3_GRU ONNX)
            </Text>
            <Text
              style={[
                styles.badge,
                {
                  color:
                    gruModelDiagnostics?.status === "READY"
                      ? theme.success
                      : gruModelDiagnostics?.status === "LOADING"
                      ? theme.warning
                      : theme.danger,
                  borderColor:
                    gruModelDiagnostics?.status === "READY"
                      ? theme.success
                      : theme.danger,
                },
              ]}
            >
              {gruModelDiagnostics?.status ?? "INITIALIZING"}
            </Text>
          </View>

          <View style={styles.dataRow}>
            <View style={[styles.col, { flex: 2 }]}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                BACKEND / FILE
              </Text>
              <Text
                style={[styles.valMono, { color: theme.textPrimary }]}
                numberOfLines={1}
              >
                {gruModelDiagnostics?.modelFile ?? "b3_gru_clean.onnx"}
              </Text>
              <Text style={[styles.sub, { color: theme.textSecondary }]}>
                Runtime: {gruModelDiagnostics?.runtime?.toUpperCase() ?? "ORT-CPU"}
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                LATENCY
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {safeNum(gruModelDiagnostics?.lastInferenceLatencyMs, 1, "--", " ms")}
              </Text>
              <Text style={[styles.sub, { color: theme.textSecondary }]}>
                Target: &lt;5 ms
              </Text>
            </View>
          </View>

          <View style={styles.dataRow}>
            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                INFERENCES
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {gruModelDiagnostics?.totalInferences ?? 0}
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                WINDOW FILL
              </Text>
              <Text
                style={[
                  styles.val,
                  {
                    color:
                      (gruModelDiagnostics?.windowFill ?? 0) >= 20
                        ? theme.success
                        : theme.warning,
                  },
                ]}
              >
                {gruModelDiagnostics?.windowFill ?? 0}/20
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                PRED SPEED
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {safeNum(
                  gruModelDiagnostics?.lastVelocityMps
                    ? gruModelDiagnostics.lastVelocityMps * 3.6
                    : null,
                  1,
                  "--",
                  " km/h",
                )}
              </Text>
            </View>
          </View>
        </View>

        {/* ============================================================ */}
        {/* SECTION 3: ROAD COVERAGE & PREFETCH                          */}
        {/* ============================================================ */}
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.surfaceSubtle,
              borderColor: theme.surfaceBorder,
            },
          ]}
        >
          <View style={styles.cardHeader}>
            <Text style={[styles.cardTitle, { color: theme.accent }]}>
              3. ROAD COVERAGE & PREFETCH
            </Text>
            <Text
              style={[
                styles.badge,
                {
                  color:
                    roadCoverageDiagnostics?.sourcePosition === "REPLAY"
                      ? theme.warning
                      : theme.success,
                  borderColor:
                    roadCoverageDiagnostics?.sourcePosition === "REPLAY"
                      ? theme.warning
                      : theme.success,
                },
              ]}
            >
              SOURCE: {roadCoverageDiagnostics?.sourcePosition ?? "LIVE"}
            </Text>
          </View>

          <View style={styles.dataRow}>
            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                ACTIVE REGION
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {roadCoverageDiagnostics?.activeRegionId?.toUpperCase() ?? "LOCAL"}
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                PLANNER MODE
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {roadCoverageDiagnostics?.planner ?? "FREE_DRIVE"}
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                ACTIVE TILES
              </Text>
              <Text style={[styles.valHighlight, { color: theme.textPrimary }]}>
                {roadCoverageDiagnostics?.loadedTileCount ?? 0}
              </Text>
            </View>
          </View>

          <View style={styles.dataRow}>
            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                CACHE HITS
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {roadCoverageDiagnostics?.cacheHitCount ?? 0}
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                COALESCED SKIPS
              </Text>
              <Text style={[styles.val, { color: theme.success }]}>
                {roadCoverageDiagnostics?.coalescedSkipCount ?? 0}
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                TRIGGER
              </Text>
              <Text
                style={[styles.val, { color: theme.textSecondary, fontSize: 10 }]}
                numberOfLines={1}
              >
                {roadCoverageDiagnostics?.lastTriggerReason ?? "HEARTBEAT"}
              </Text>
            </View>
          </View>
        </View>

        {/* ============================================================ */}
        {/* SECTION 4: REPLAY BENCHMARK & DRIFT                          */}
        {/* ============================================================ */}
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.surfaceSubtle,
              borderColor: replayTelemetry ? "#FF9100" : theme.surfaceBorder,
            },
          ]}
        >
          <View style={styles.cardHeader}>
            <Text style={[styles.cardTitle, { color: "#FF9100" }]}>
              4. REPLAY BENCHMARK & DRIFT
            </Text>
            <Text
              style={[
                styles.badge,
                {
                  color: replayTelemetry ? "#FF9100" : theme.textMuted,
                  borderColor: replayTelemetry ? "#FF9100" : theme.surfaceBorder,
                },
              ]}
            >
              {replayTelemetry
                ? `SESSION: ${replayTelemetry.sessionId.toUpperCase()}`
                : "REPLAY INACTIVE"}
            </Text>
          </View>

          {replayTelemetry ? (
            <>
              <View style={styles.dataRow}>
                <View style={styles.col}>
                  <Text style={[styles.label, { color: theme.textMuted }]}>
                    VIRTUAL CLOCK
                  </Text>
                  <Text style={[styles.val, { color: theme.textPrimary }]}>
                    {formatMs(replayTelemetry.elapsedTimeMs)} /{" "}
                    {formatMs(replayTelemetry.totalDurationMs)}
                  </Text>
                  <Text style={[styles.sub, { color: theme.textSecondary }]}>
                    Speed: {replayTelemetry.speed}x
                  </Text>
                </View>

                <View style={styles.col}>
                  <Text style={[styles.label, { color: theme.textMuted }]}>
                    POSITION ERROR
                  </Text>
                  <Text style={[styles.valHighlight, { color: "#F57C00" }]}>
                    {safeNum(replayTelemetry.instantaneousErrorMeters, 1, "--", " m")}
                  </Text>
                </View>

                <View style={styles.col}>
                  <Text style={[styles.label, { color: theme.textMuted }]}>
                    SIH DRIFT RATIO
                  </Text>
                  <Text style={[styles.valHighlight, { color: theme.accent }]}>
                    {safeNum(replayTelemetry.cumulativeDriftPercent, 1, "N/A", "%")}
                  </Text>
                  <Text style={[styles.sub, { color: theme.textSecondary }]}>
                    Ref: {safeNum(replayTelemetry.cumulativeDistanceTraveledM, 0, "0", "m")}
                  </Text>
                </View>
              </View>

              {/* Milestones chips */}
              <View style={styles.milestonesContainer}>
                <Text style={[styles.label, { color: theme.textMuted, marginBottom: 4 }]}>
                  MILESTONES (ERROR / DRIFT %)
                </Text>
                <View style={styles.milestonesChipsRow}>
                  {(
                    [
                      { label: "5s", err: replayTelemetry.milestoneErrors?.at5s, d: replayTelemetry.milestoneDrifts?.at5s },
                      { label: "10s", err: replayTelemetry.milestoneErrors?.at10s, d: replayTelemetry.milestoneDrifts?.at10s },
                      { label: "20s", err: replayTelemetry.milestoneErrors?.at20s, d: replayTelemetry.milestoneDrifts?.at20s },
                      { label: "30s", err: replayTelemetry.milestoneErrors?.at30s, d: replayTelemetry.milestoneDrifts?.at30s },
                      { label: "60s", err: replayTelemetry.milestoneErrors?.at60s, d: replayTelemetry.milestoneDrifts?.at60s },
                    ] as const
                  ).map((m) => (
                    <View
                      key={m.label}
                      style={[
                        styles.milestoneChip,
                        {
                          backgroundColor: theme.surface,
                          borderColor: theme.surfaceBorder,
                        },
                      ]}
                    >
                      <Text style={[styles.milestoneLabel, { color: theme.textMuted }]}>
                        {m.label}
                      </Text>
                      <Text style={[styles.milestoneVal, { color: theme.textPrimary }]}>
                        {safeNum(m.err, 1, "--", "m")}
                      </Text>
                      <Text style={[styles.milestoneDrift, { color: theme.accent }]}>
                        {m.d !== null && m.d !== undefined ? `${m.d}%` : "--"}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            </>
          ) : (
            <Text style={[styles.inactiveNotice, { color: theme.textSecondary }]}>
              Live driving mode active. Open Replay Lab to run reproducible IO-VNBD benchmark sessions.
            </Text>
          )}
        </View>

        {/* ============================================================ */}
        {/* SECTION 5: GNSS & SENSOR FUSION                              */}
        {/* ============================================================ */}
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.surfaceSubtle,
              borderColor:
                gnssStatus === "VALID"
                  ? theme.success
                  : gnssStatus === "STALE"
                  ? theme.warning
                  : theme.danger,
            },
          ]}
        >
          <View style={styles.cardHeader}>
            <Text style={[styles.cardTitle, { color: theme.accent }]}>
              5. GNSS & SENSOR FUSION
            </Text>
            <Text
              style={[
                styles.badge,
                {
                  color:
                    gnssStatus === "VALID"
                      ? theme.success
                      : gnssStatus === "STALE"
                      ? theme.warning
                      : theme.danger,
                  borderColor:
                    gnssStatus === "VALID"
                      ? theme.success
                      : theme.danger,
                },
              ]}
            >
              GNSS {gnssStatus ?? "UNKNOWN"}
            </Text>
          </View>

          <View style={styles.dataRow}>
            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                FIX AGE
              </Text>
              <Text
                style={[
                  styles.val,
                  {
                    color:
                      lastGnssFixAgeMs == null
                        ? theme.textMuted
                        : lastGnssFixAgeMs < 2000
                        ? theme.success
                        : lastGnssFixAgeMs < 5000
                        ? theme.warning
                        : theme.danger,
                  },
                ]}
              >
                {lastGnssFixAgeMs != null ? `${lastGnssFixAgeMs} ms` : "--"}
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                GNSS FIXES
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {gnssFixCount ?? 0}
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                ESKF UPDATES
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {eskfGnssUpdateCount ?? 0}
              </Text>
            </View>
          </View>

          <View style={styles.coordsRow}>
            <View style={styles.coordCol}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                RAW GNSS FIX
              </Text>
              <Text style={[styles.valMono, { color: theme.textPrimary }]}>
                {rawGnssLocation
                  ? `${rawGnssLocation.latitude.toFixed(6)}, ${rawGnssLocation.longitude.toFixed(6)}`
                  : `${latText}, ${lngText}`}
              </Text>
              <Text style={[styles.sub, { color: theme.textSecondary }]}>
                Acc: {rawGnssLocation?.accuracy != null ? `±${rawGnssLocation.accuracy.toFixed(1)}m` : accText} • Alt: {altText}
              </Text>
            </View>

            <View style={styles.coordCol}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                ESKF FUSED STATE
              </Text>
              <Text style={[styles.valMono, { color: theme.textPrimary }]}>
                {currentPositionEstimate
                  ? `${currentPositionEstimate.latitude.toFixed(6)}, ${currentPositionEstimate.longitude.toFixed(6)}`
                  : "--"}
              </Text>
              <Text style={[styles.sub, { color: theme.textSecondary }]}>
                Unc: {currentPositionEstimate?.horizontal_accuracy != null ? `±${currentPositionEstimate.horizontal_accuracy.toFixed(1)}m` : "--"}
              </Text>
            </View>
          </View>
        </View>

        {/* ============================================================ */}
        {/* SECTION 6: PERFORMANCE & RAM BUDGET                          */}
        {/* ============================================================ */}
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.surfaceSubtle,
              borderColor:
                roadMemoryDiagnostics?.memoryPressure === "AGGRESSIVE"
                  ? theme.danger
                  : roadMemoryDiagnostics?.memoryPressure === "PRESSURE"
                  ? theme.warning
                  : theme.surfaceBorder,
            },
          ]}
        >
          <View style={styles.cardHeader}>
            <Text style={[styles.cardTitle, { color: theme.accent }]}>
              6. PERFORMANCE & RAM BUDGET
            </Text>
            <Text
              style={[
                styles.badge,
                {
                  color:
                    roadMemoryDiagnostics?.memoryPressure === "AGGRESSIVE"
                      ? theme.danger
                      : roadMemoryDiagnostics?.memoryPressure === "PRESSURE"
                      ? theme.warning
                      : theme.success,
                  borderColor:
                    roadMemoryDiagnostics?.memoryPressure === "AGGRESSIVE"
                      ? theme.danger
                      : theme.success,
                },
              ]}
            >
              PRESSURE: {roadMemoryDiagnostics?.memoryPressure ?? "NORMAL"}
            </Text>
          </View>

          <View style={styles.dataRow}>
            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                UPDATE FREQ
              </Text>
              <Text
                style={[
                  styles.valHighlight,
                  { color: updateFrequencyHz > 0 ? theme.success : theme.danger },
                ]}
              >
                ~{updateFrequencyHz.toFixed(1)} Hz
              </Text>
              <Text style={[styles.sub, { color: theme.textSecondary }]}>
                Target: ~10 Hz
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                ROAD RAM USED
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {((roadMemoryDiagnostics?.ramRoadBytes ?? 0) / (1024 * 1024)).toFixed(2)} MB
              </Text>
              <Text style={[styles.sub, { color: theme.textSecondary }]}>
                Budget: {((roadMemoryDiagnostics?.ramBudgetBytes ?? 15728640) / (1024 * 1024)).toFixed(0)} MB
              </Text>
            </View>

            <View style={styles.col}>
              <Text style={[styles.label, { color: theme.textMuted }]}>
                EVICTIONS
              </Text>
              <Text style={[styles.val, { color: theme.textPrimary }]}>
                {roadMemoryDiagnostics?.evictionCount ?? 0}
              </Text>
              <Text style={[styles.sub, { color: theme.textSecondary }]}>
                Segs: {roadMemoryDiagnostics?.activeSegmentCount ?? 0}
              </Text>
            </View>
          </View>

          <View style={styles.streamGateRow}>
            <Text style={[styles.sub, { color: theme.textSecondary }]}>
              GNSS Stream Gate:{" "}
              <Text
                style={{
                  fontWeight: "700",
                  color:
                    gnssStreamGateState === "GNSS_STREAM_DISABLED"
                      ? theme.danger
                      : theme.success,
                }}
              >
                {gnssStreamGateState === "GNSS_STREAM_DISABLED"
                  ? "STREAM BLOCKED (OUTAGE)"
                  : "STREAM PERMITTED"}
              </Text>
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  bottomSheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: "48%",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    paddingHorizontal: 14,
    elevation: 24,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    zIndex: 999,
  },
  dragHandleContainer: {
    width: "100%",
    alignItems: "center",
    paddingVertical: 7,
  },
  dragHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: 8,
    borderBottomWidth: 1,
    marginBottom: 8,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  indicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  title: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  closeTouch: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: {
    fontSize: 14,
    fontWeight: "700",
  },
  scrollContainer: {
    flex: 1,
  },
  scrollContent: {
    gap: 10,
    paddingBottom: 16,
  },
  card: {
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    gap: 8,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(150, 150, 150, 0.15)",
  },
  cardTitle: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  badge: {
    fontSize: 9,
    fontWeight: "800",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  dataRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
  },
  col: {
    flex: 1,
  },
  label: {
    fontSize: 8.5,
    fontWeight: "700",
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  val: {
    fontSize: 12.5,
    fontWeight: "700",
  },
  valHighlight: {
    fontSize: 14,
    fontWeight: "800",
  },
  valMono: {
    fontSize: 10.5,
    fontWeight: "700",
    fontFamily: "monospace",
  },
  unit: {
    fontSize: 9.5,
    fontWeight: "600",
  },
  sub: {
    fontSize: 8.5,
    marginTop: 2,
  },
  coordsRow: {
    flexDirection: "row",
    gap: 8,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: "rgba(150, 150, 150, 0.12)",
  },
  coordCol: {
    flex: 1,
  },
  milestonesContainer: {
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: "rgba(150, 150, 150, 0.12)",
  },
  milestonesChipsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 4,
  },
  milestoneChip: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 4,
    paddingHorizontal: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  milestoneLabel: {
    fontSize: 8,
    fontWeight: "700",
  },
  milestoneVal: {
    fontSize: 10,
    fontWeight: "800",
  },
  milestoneDrift: {
    fontSize: 8,
    fontWeight: "700",
  },
  inactiveNotice: {
    fontSize: 10.5,
    lineHeight: 15,
    fontStyle: "italic",
  },
  streamGateRow: {
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: "rgba(150, 150, 150, 0.12)",
  },
});
