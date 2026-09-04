import React, { useEffect, useState } from "react";
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  HardwareInventory,
  SensorTelemetry,
  SessionListItem,
  SessionSummary,
} from "../../core/types/sensors";
import { sensorRecorderManager } from "../../services/sensors/SensorRecorderManager";
import { NavLocation } from "../../core/types/location";
import { NavigationTelemetry } from "../../core/types/navigation";
import { navigationManager } from "../../core/state/NavigationManager";
import { useTheme } from "../../theme/ThemeContext";
import { AppTheme, AppThemeMode } from "../../theme/types";

interface SensorDiagnosticsModalProps {
  visible: boolean;
  onClose: () => void;
  currentLocation: NavLocation | null;
}

export const SensorDiagnosticsModal: React.FC<SensorDiagnosticsModalProps> = ({
  visible,
  onClose,
  currentLocation,
}) => {
  const { theme, mode } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => getStyles(theme, mode), [theme, mode]);

  const [telemetry, setTelemetry] = useState<SensorTelemetry | null>(null);
  const [navTelemetry, setNavTelemetry] = useState<NavigationTelemetry | null>(
    null,
  );
  const [hardware, setHardware] = useState<HardwareInventory | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loadingAction, setLoadingAction] = useState(false);
  const [lastSummary, setLastSummary] = useState<SessionSummary | null>(null);

  useEffect(() => {
    if (!visible) return;

    // Start native monitoring when modal is opened
    sensorRecorderManager.startMonitoring();

    // Fetch hardware specifications
    sensorRecorderManager.getSensorHardwareInfo().then((info) => {
      if (info) setHardware(info);
    });

    // Refresh recorded sessions list
    loadSessions();

    // Subscribe to throttled 5 Hz telemetry
    const unsubscribe = sensorRecorderManager.addTelemetryListener((data) => {
      setTelemetry(data);
    });

    // Subscribe to NavigationManager telemetry (gate state, positioning estimates)
    const unsubNav = navigationManager.subscribeTelemetry((data) => {
      setNavTelemetry(data);
    });

    return () => {
      unsubscribe();
      unsubNav();
    };
  }, [visible]);

  const loadSessions = async () => {
    const list = await sensorRecorderManager.listSessions();
    setSessions(list);
  };

  const handleStartRecording = async () => {
    setLoadingAction(true);
    try {
      await sensorRecorderManager.startRecording("idr_drive");
      setLastSummary(null);
    } catch (e: any) {
      Alert.alert("Recording Error", e.message || "Failed to start recording");
    } finally {
      setLoadingAction(false);
    }
  };

  const handleStopRecording = async () => {
    setLoadingAction(true);
    try {
      const summary = await sensorRecorderManager.stopRecording();
      setLastSummary(summary);
      await loadSessions();
    } catch (e: any) {
      Alert.alert("Stop Error", e.message || "Failed to stop recording");
    } finally {
      setLoadingAction(false);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    Alert.alert(
      "Delete Session",
      `Are you sure you want to delete session ${sessionId}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            await sensorRecorderManager.deleteSession(sessionId);
            await loadSessions();
          },
        },
      ],
    );
  };

  const isRecording = telemetry?.recording.isRecording ?? false;
  const elapsedSec = telemetry?.recording.elapsedSeconds ?? 0;
  const minutes = Math.floor(elapsedSec / 60);
  const seconds = Math.floor(elapsedSec % 60);
  const formattedTime = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  const accel = telemetry?.accelerometer;
  const gyro = telemetry?.gyroscope;
  const mag = telemetry?.magnetometer;
  const orient = telemetry?.orientation;
  const accelMag = accel
    ? Math.sqrt(
        accel.x * accel.x + accel.y * accel.y + accel.z * accel.z,
      ).toFixed(2)
    : "--";

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.titleContainer}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                IMU Sensor Lab & Recorder
              </Text>
              <Text style={styles.headerSubtitle} numberOfLines={1}>
                Research Telemetry & IDR Data Pipeline
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={styles.closeButton}
              accessibilityRole="button"
              accessibilityLabel="Close IMU Sensor Lab"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="close" size={24} color={theme.textPrimary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={{
              paddingBottom: Math.max(insets.bottom, 24) + 48,
            }}
            showsVerticalScrollIndicator={false}
          >
            {/* RECORDING CONTROL CARD */}
            <View
              style={[styles.card, isRecording && styles.cardRecordingActive]}
            >
              <View style={styles.recHeaderRow}>
                <View style={styles.recStatusGroup}>
                  <View
                    style={[styles.recDot, isRecording && styles.recDotPulsing]}
                  />
                  <Text style={styles.recStatusTitle}>
                    {isRecording ? "RECORDING IN PROGRESS" : "RECORDER IDLE"}
                  </Text>
                </View>
                {isRecording && (
                  <Text style={styles.recTimer}>{formattedTime}</Text>
                )}
              </View>

              {isRecording ? (
                <View style={styles.recActiveInfo}>
                  <Text style={styles.recSessionLabel}>
                    Session ID:{" "}
                    <Text style={styles.recSessionValue}>
                      {telemetry?.recording.sessionId}
                    </Text>
                  </Text>

                  {/* Sample counters */}
                  <View style={styles.recStatsGrid}>
                    <View style={styles.recStatItem}>
                      <Text style={styles.recStatNum}>
                        {telemetry?.recording.accelSamples.toLocaleString()}
                      </Text>
                      <Text style={styles.recStatLabel}>Accel (m/s²)</Text>
                    </View>
                    <View style={styles.recStatItem}>
                      <Text style={styles.recStatNum}>
                        {telemetry?.recording.gyroSamples.toLocaleString()}
                      </Text>
                      <Text style={styles.recStatLabel}>Gyro (rad/s)</Text>
                    </View>
                    <View style={styles.recStatItem}>
                      <Text style={styles.recStatNum}>
                        {telemetry?.recording.magSamples.toLocaleString()}
                      </Text>
                      <Text style={styles.recStatLabel}>Mag (µT)</Text>
                    </View>
                    <View style={styles.recStatItem}>
                      <Text style={styles.recStatNum}>
                        {telemetry?.recording.gnssSamples.toLocaleString()}
                      </Text>
                      <Text style={styles.recStatLabel}>Ref GNSS</Text>
                    </View>
                    <View style={styles.recStatItem}>
                      <Text style={styles.recStatNum}>
                        {(
                          telemetry?.recording.positionEstimateSamples ?? 0
                        ).toLocaleString()}
                      </Text>
                      <Text style={styles.recStatLabel}>Pos Est</Text>
                    </View>
                    <View style={styles.recStatItem}>
                      <Text style={styles.recStatNum}>
                        {(
                          telemetry?.recording.eventsCount ?? 0
                        ).toLocaleString()}
                      </Text>
                      <Text style={styles.recStatLabel}>Events</Text>
                    </View>
                  </View>

                  <Text style={styles.droppedText}>
                    Dropped Queue Samples:{" "}
                    {telemetry?.recording.droppedSamples ?? 0}
                  </Text>

                  <TouchableOpacity
                    style={styles.stopButton}
                    onPress={handleStopRecording}
                    disabled={loadingAction}
                  >
                    {loadingAction ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <>
                        <Ionicons name="stop" size={18} color="#FFFFFF" />
                        <Text style={styles.stopButtonText}>
                          Stop Recording
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.recIdleContainer}>
                  <Text style={styles.recPrompt}>
                    Captures raw Accel, Gyro, Mag, Orientation, Reference GNSS &
                    Position Estimates to independent streams with native
                    nanosecond timestamps.
                  </Text>
                  <TouchableOpacity
                    style={styles.startButton}
                    onPress={handleStartRecording}
                    disabled={loadingAction}
                  >
                    {loadingAction ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <>
                        <Ionicons
                          name="radio-button-on"
                          size={18}
                          color="#FFFFFF"
                        />
                        <Text style={styles.startButtonText}>
                          Start Recording
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              )}

              {lastSummary && (
                <View style={styles.summaryBox}>
                  <Text style={styles.summaryTitle}>
                    ✓ Session Saved Successfully
                  </Text>
                  <Text style={styles.summaryText}>
                    ID: {lastSummary.sessionId}
                  </Text>
                  <Text style={styles.summaryText}>
                    Duration: {lastSummary.durationSeconds.toFixed(1)}s • Accel:{" "}
                    {lastSummary.accelSamples} • Gyro: {lastSummary.gyroSamples}{" "}
                    • Ref GNSS: {lastSummary.gnssSamples} • Pos Est:{" "}
                    {lastSummary.positionEstimateSamples ?? 0} • Events:{" "}
                    {lastSummary.eventsCount ?? 0}
                  </Text>
                  <Text style={styles.summaryPath}>
                    {lastSummary.sessionPath}
                  </Text>
                </View>
              )}
            </View>

            {/* POSITIONING TEST (GNSS OUTAGE SIMULATOR) CARD */}
            <View
              style={[
                styles.card,
                navTelemetry?.gnssStreamGateState === "GNSS_STREAM_DISABLED" &&
                  styles.cardOutageActive,
              ]}
            >
              <View style={styles.cardHeader}>
                <View style={styles.cardTitleRow}>
                  <Ionicons
                    name={
                      navTelemetry?.gnssStreamGateState ===
                      "GNSS_STREAM_DISABLED"
                        ? "warning-outline"
                        : "radio"
                    }
                    size={18}
                    color={
                      navTelemetry?.gnssStreamGateState ===
                      "GNSS_STREAM_DISABLED"
                        ? "#D93025"
                        : "#137333"
                    }
                  />
                  <Text style={styles.cardTitle}>
                    GNSS Outage Simulator (Phase 3A)
                  </Text>
                </View>
                <View
                  style={[
                    styles.hzBadge,
                    {
                      backgroundColor:
                        navTelemetry?.gnssStreamGateState ===
                        "GNSS_STREAM_DISABLED"
                          ? "#FCE8E6"
                          : "#E6F4EA",
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.hzText,
                      {
                        color:
                          navTelemetry?.gnssStreamGateState ===
                          "GNSS_STREAM_DISABLED"
                            ? "#D93025"
                            : "#137333",
                        fontWeight: "800",
                      },
                    ]}
                  >
                    {navTelemetry?.gnssStreamGateState ===
                    "GNSS_STREAM_DISABLED"
                      ? "STREAM BLOCKED"
                      : "STREAM ACTIVE"}
                  </Text>
                </View>
              </View>

              <Text style={styles.sensorSubtext}>
                Software gate between GnssLocationProvider and
                PositioningEngine. Android Fused Location continues
                uninterrupted reference recording.
              </Text>

              {/* Status Box */}
              <View style={styles.gateStatusBox}>
                <View style={styles.gateStatusRow}>
                  <Text style={styles.gateStatusLabel}>Gate State:</Text>
                  <Text
                    style={[
                      styles.gateStatusValue,
                      {
                        color:
                          navTelemetry?.gnssStreamGateState ===
                          "GNSS_STREAM_DISABLED"
                            ? "#D93025"
                            : "#137333",
                      },
                    ]}
                  >
                    {navTelemetry?.gnssStreamGateState ===
                    "GNSS_STREAM_DISABLED"
                      ? "GNSS STREAM BLOCKED — SIMULATED OUTAGE"
                      : "GNSS STREAM ENABLED"}
                  </Text>
                </View>
                <View style={styles.gateStatusRow}>
                  <Text style={styles.gateStatusLabel}>
                    Positioning Engine:
                  </Text>
                  <Text style={styles.gateStatusValue}>
                    {navTelemetry?.positioningStatus ?? "IDLE"}
                    {navTelemetry?.currentPositionEstimate?.valid
                      ? " (Valid Fix)"
                      : " (No Valid Fix)"}
                  </Text>
                </View>
              </View>

              {/* Live Outage Stats Comparison */}
              <View style={styles.recStatsGrid}>
                <View style={styles.recStatItem}>
                  <Text style={styles.recStatNum}>
                    {telemetry?.recording.gnssSamples ?? 0}
                  </Text>
                  <Text style={styles.recStatLabel}>Reference GNSS</Text>
                </View>
                <View style={styles.recStatItem}>
                  <Text style={styles.recStatNum}>
                    {telemetry?.recording.positionEstimateSamples ?? 0}
                  </Text>
                  <Text style={styles.recStatLabel}>Position Est.</Text>
                </View>
                <View style={styles.recStatItem}>
                  <Text style={styles.recStatNum}>
                    {telemetry?.recording.eventsCount ?? 0}
                  </Text>
                  <Text style={styles.recStatLabel}>Outage Events</Text>
                </View>
              </View>

              {/* Outage Toggle Button */}
              <TouchableOpacity
                style={[
                  styles.gateButton,
                  navTelemetry?.gnssStreamGateState === "GNSS_STREAM_DISABLED"
                    ? styles.gateButtonBlocked
                    : styles.gateButtonActive,
                ]}
                onPress={() => navigationManager.toggleGnssStreamGate()}
                activeOpacity={0.8}
              >
                <Ionicons
                  name={
                    navTelemetry?.gnssStreamGateState === "GNSS_STREAM_DISABLED"
                      ? "play-circle"
                      : "pause-circle"
                  }
                  size={18}
                  color="#FFFFFF"
                />
                <Text style={styles.gateButtonText}>
                  {navTelemetry?.gnssStreamGateState === "GNSS_STREAM_DISABLED"
                    ? "Resume GNSS Stream (Enable)"
                    : "Simulate GNSS Outage (Block Stream)"}
                </Text>
              </TouchableOpacity>
            </View>

            {/* LIVE ACCELEROMETER CARD */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.cardTitleRow}>
                  <Ionicons
                    name="speedometer-outline"
                    size={18}
                    color="#1A73E8"
                  />
                  <Text style={styles.cardTitle}>Accelerometer (Raw m/s²)</Text>
                </View>
                <View style={styles.hzBadge}>
                  <Text style={styles.hzText}>
                    {accel?.hz ? `${accel.hz.toFixed(1)} Hz` : "-- Hz"}
                  </Text>
                </View>
              </View>
              <Text style={styles.sensorSubtext}>
                {hardware?.accelerometer.name ?? "Scanning hardware..."}
              </Text>

              <View style={styles.vectorRow}>
                <View style={styles.axisItem}>
                  <Text style={styles.axisLabel}>X (Lateral)</Text>
                  <Text style={styles.axisValue}>
                    {accel?.x ? accel.x.toFixed(3) : "--"}
                  </Text>
                </View>
                <View style={styles.axisItem}>
                  <Text style={styles.axisLabel}>Y (Longitudinal)</Text>
                  <Text style={styles.axisValue}>
                    {accel?.y ? accel.y.toFixed(3) : "--"}
                  </Text>
                </View>
                <View style={styles.axisItem}>
                  <Text style={styles.axisLabel}>Z (Vertical)</Text>
                  <Text style={styles.axisValue}>
                    {accel?.z ? accel.z.toFixed(3) : "--"}
                  </Text>
                </View>
                <View style={styles.axisItem}>
                  <Text style={styles.axisLabel}>|Norm| (g)</Text>
                  <Text style={styles.axisValueHighlight}>{accelMag}</Text>
                </View>
              </View>
            </View>

            {/* LIVE GYROSCOPE CARD */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.cardTitleRow}>
                  <Ionicons name="sync-outline" size={18} color="#0D652D" />
                  <Text style={styles.cardTitle}>Gyroscope (Raw rad/s)</Text>
                </View>
                <View style={[styles.hzBadge, { backgroundColor: "#E6F4EA" }]}>
                  <Text style={[styles.hzText, { color: "#0D652D" }]}>
                    {gyro?.hz ? `${gyro.hz.toFixed(1)} Hz` : "-- Hz"}
                  </Text>
                </View>
              </View>
              <Text style={styles.sensorSubtext}>
                {hardware?.gyroscope.name ?? "Scanning hardware..."}
              </Text>

              <View style={styles.vectorRow}>
                <View style={styles.axisItem}>
                  <Text style={styles.axisLabel}>X (Pitch rate)</Text>
                  <Text style={styles.axisValue}>
                    {gyro?.x ? gyro.x.toFixed(4) : "--"}
                  </Text>
                </View>
                <View style={styles.axisItem}>
                  <Text style={styles.axisLabel}>Y (Roll rate)</Text>
                  <Text style={styles.axisValue}>
                    {gyro?.y ? gyro.y.toFixed(4) : "--"}
                  </Text>
                </View>
                <View style={styles.axisItem}>
                  <Text style={styles.axisLabel}>Z (Yaw rate)</Text>
                  <Text style={styles.axisValue}>
                    {gyro?.z ? gyro.z.toFixed(4) : "--"}
                  </Text>
                </View>
              </View>
            </View>

            {/* LIVE MAGNETOMETER CARD */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.cardTitleRow}>
                  <Ionicons name="compass-outline" size={18} color="#E37400" />
                  <Text style={styles.cardTitle}>Magnetometer (Raw µT)</Text>
                </View>
                <View style={[styles.hzBadge, { backgroundColor: "#FEF7E0" }]}>
                  <Text style={[styles.hzText, { color: "#B06000" }]}>
                    {mag?.hz ? `${mag.hz.toFixed(1)} Hz` : "-- Hz"}
                  </Text>
                </View>
              </View>
              <Text style={styles.sensorSubtext}>
                {hardware?.magnetometer.available
                  ? hardware.magnetometer.name
                  : "Not Available on this device"}
              </Text>

              <View style={styles.vectorRow}>
                <View style={styles.axisItem}>
                  <Text style={styles.axisLabel}>X (µT)</Text>
                  <Text style={styles.axisValue}>
                    {mag?.x ? mag.x.toFixed(1) : "--"}
                  </Text>
                </View>
                <View style={styles.axisItem}>
                  <Text style={styles.axisLabel}>Y (µT)</Text>
                  <Text style={styles.axisValue}>
                    {mag?.y ? mag.y.toFixed(1) : "--"}
                  </Text>
                </View>
                <View style={styles.axisItem}>
                  <Text style={styles.axisLabel}>Z (µT)</Text>
                  <Text style={styles.axisValue}>
                    {mag?.z ? mag.z.toFixed(1) : "--"}
                  </Text>
                </View>
              </View>
            </View>

            {/* LIVE DERIVED ORIENTATION CARD */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.cardTitleRow}>
                  <Ionicons name="navigate-outline" size={18} color="#7B1FA2" />
                  <Text style={styles.cardTitle}>
                    Derived Attitude / Orientation
                  </Text>
                </View>
                <View style={[styles.hzBadge, { backgroundColor: "#F3E8FD" }]}>
                  <Text style={[styles.hzText, { color: "#7B1FA2" }]}>
                    {orient?.hz ? `${orient.hz.toFixed(1)} Hz` : "-- Hz"}
                  </Text>
                </View>
              </View>
              <Text style={styles.sensorSubtext}>
                Derived from Android Rotation Vector (Reference, not ground
                truth)
              </Text>

              <View style={styles.vectorRow}>
                <View style={styles.axisItem}>
                  <Text style={styles.axisLabel}>Roll (Φ)</Text>
                  <Text style={styles.axisValue}>
                    {orient?.rollDeg ? `${orient.rollDeg.toFixed(1)}°` : "--"}
                  </Text>
                  <Text style={styles.radSub}>
                    {orient?.rollRad ? `${orient.rollRad.toFixed(3)} rad` : ""}
                  </Text>
                </View>
                <View style={styles.axisItem}>
                  <Text style={styles.axisLabel}>Pitch (θ)</Text>
                  <Text style={styles.axisValue}>
                    {orient?.pitchDeg ? `${orient.pitchDeg.toFixed(1)}°` : "--"}
                  </Text>
                  <Text style={styles.radSub}>
                    {orient?.pitchRad
                      ? `${orient.pitchRad.toFixed(3)} rad`
                      : ""}
                  </Text>
                </View>
                <View style={styles.axisItem}>
                  <Text style={styles.axisLabel}>Yaw / Azimuth (ψ)</Text>
                  <Text style={styles.axisValue}>
                    {orient?.yawDeg ? `${orient.yawDeg.toFixed(1)}°` : "--"}
                  </Text>
                  <Text style={styles.radSub}>
                    {orient?.yawRad ? `${orient.yawRad.toFixed(3)} rad` : ""}
                  </Text>
                </View>
              </View>
            </View>

            {/* GNSS / REFERENCE POSITION CARD */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.cardTitleRow}>
                  <Ionicons name="location-outline" size={18} color="#185ABC" />
                  <Text style={styles.cardTitle}>
                    GNSS / Reference Location
                  </Text>
                </View>
                <View style={styles.hzBadge}>
                  <Text style={styles.hzText}>
                    {currentLocation?.source?.toUpperCase() ?? "GNSS"}
                  </Text>
                </View>
              </View>
              <Text style={styles.sensorSubtext}>
                Android Fused Location Provider • Reference Trajectory
              </Text>

              <View style={styles.gnssGrid}>
                <View style={styles.gnssItem}>
                  <Text style={styles.gnssLabel}>Latitude</Text>
                  <Text style={styles.gnssValue}>
                    {currentLocation?.latitude.toFixed(6) ?? "--"}
                  </Text>
                </View>
                <View style={styles.gnssItem}>
                  <Text style={styles.gnssLabel}>Longitude</Text>
                  <Text style={styles.gnssValue}>
                    {currentLocation?.longitude.toFixed(6) ?? "--"}
                  </Text>
                </View>
                <View style={styles.gnssItem}>
                  <Text style={styles.gnssLabel}>Accuracy (H)</Text>
                  <Text style={styles.gnssValue}>
                    {currentLocation?.accuracy
                      ? `±${currentLocation.accuracy.toFixed(1)} m`
                      : "--"}
                  </Text>
                </View>
                <View style={styles.gnssItem}>
                  <Text style={styles.gnssLabel}>Speed</Text>
                  <Text style={styles.gnssValue}>
                    {currentLocation?.speed
                      ? `${(currentLocation.speed * 3.6).toFixed(1)} km/h`
                      : "0 km/h"}
                  </Text>
                </View>
              </View>
            </View>

            {/* RECORDED SESSIONS LIST */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.cardTitleRow}>
                  <Ionicons name="folder-outline" size={18} color="#3C4043" />
                  <Text style={styles.cardTitle}>
                    Recorded Sessions on Device
                  </Text>
                </View>
                <TouchableOpacity onPress={loadSessions}>
                  <Ionicons name="refresh" size={18} color="#1A73E8" />
                </TouchableOpacity>
              </View>

              {sessions.length === 0 ? (
                <Text style={styles.emptySessions}>
                  No recorded sessions yet.
                </Text>
              ) : (
                sessions.map((sess) => (
                  <View key={sess.sessionId} style={styles.sessionRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.sessionName}>{sess.sessionId}</Text>
                      <Text style={styles.sessionMeta}>
                        {sess.durationSeconds
                          ? `${sess.durationSeconds.toFixed(1)}s • `
                          : ""}
                        {(sess.sizeBytes / 1024).toFixed(0)} KB
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => handleDeleteSession(sess.sessionId)}
                      style={styles.deleteBtn}
                    >
                      <Ionicons
                        name="trash-outline"
                        size={16}
                        color="#D93025"
                      />
                    </TouchableOpacity>
                  </View>
                ))
              )}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const getStyles = (theme: AppTheme, mode: AppThemeMode) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: mode === "dark" ? "rgba(0,0,0,0.75)" : "rgba(0,0,0,0.6)",
      justifyContent: "flex-end",
    },
    container: {
      backgroundColor: theme.background,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      maxHeight: "92%",
      paddingTop: 16,
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingBottom: 14,
      borderBottomWidth: 1,
      borderBottomColor: theme.surfaceBorder,
    },
    titleContainer: {
      flex: 1,
      marginRight: 12,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: "800",
      color: theme.textPrimary,
    },
    headerSubtitle: {
      fontSize: 11,
      color: theme.textSecondary,
      marginTop: 2,
    },
    closeButton: {
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surfaceSubtle,
    },
    scroll: {
      paddingHorizontal: 16,
      paddingTop: 14,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: 14,
      padding: 14,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: theme.surfaceBorder,
      elevation: 2,
      shadowColor: "#000",
      shadowOpacity: mode === "dark" ? 0.3 : 0.05,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 2 },
    },
    cardRecordingActive: {
      borderColor: theme.danger,
      borderWidth: 1.5,
      backgroundColor: mode === "dark" ? "#2B1115" : "#FFF8F8",
    },
    recHeaderRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    recStatusGroup: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    recDot: {
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: theme.textMuted,
    },
    recDotPulsing: {
      backgroundColor: theme.danger,
    },
    recStatusTitle: {
      fontSize: 13,
      fontWeight: "800",
      color: theme.textPrimary,
      letterSpacing: 0.5,
    },
    recTimer: {
      fontSize: 18,
      fontWeight: "900",
      color: theme.danger,
      fontVariant: ["tabular-nums"],
    },
    recActiveInfo: {
      marginTop: 10,
    },
    recSessionLabel: {
      fontSize: 12,
      color: theme.textSecondary,
    },
    recSessionValue: {
      fontWeight: "700",
      color: theme.textPrimary,
    },
    recStatsGrid: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginTop: 10,
      backgroundColor: theme.surfaceSubtle,
      padding: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.surfaceBorder,
    },
    recStatItem: {
      alignItems: "center",
    },
    recStatNum: {
      fontSize: 14,
      fontWeight: "800",
      color: theme.danger,
    },
    recStatLabel: {
      fontSize: 10,
      color: theme.textMuted,
      marginTop: 2,
    },
    droppedText: {
      fontSize: 11,
      color: theme.textMuted,
      marginTop: 6,
      textAlign: "right",
    },
    stopButton: {
      backgroundColor: theme.danger,
      borderRadius: 10,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      minHeight: 48,
      paddingVertical: 12,
      gap: 8,
      marginTop: 12,
    },
    stopButtonText: {
      color: "#FFFFFF",
      fontWeight: "800",
      fontSize: 14,
    },
    recIdleContainer: {
      marginTop: 8,
    },
    recPrompt: {
      fontSize: 12,
      color: theme.textSecondary,
      lineHeight: 17,
    },
    startButton: {
      backgroundColor: theme.accent,
      borderRadius: 10,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      minHeight: 48,
      paddingVertical: 12,
      gap: 8,
      marginTop: 10,
    },
    startButtonText: {
      color: "#FFFFFF",
      fontWeight: "800",
      fontSize: 14,
    },
    summaryBox: {
      marginTop: 12,
      padding: 10,
      backgroundColor: mode === "dark" ? "#102C17" : "#E6F4EA",
      borderRadius: 8,
      borderWidth: 1,
      borderColor: mode === "dark" ? "#1C4A27" : "#CEEAD6",
    },
    summaryTitle: {
      color: theme.success,
      fontWeight: "800",
      fontSize: 12,
    },
    summaryText: {
      color: theme.success,
      fontSize: 11,
      marginTop: 2,
    },
    summaryPath: {
      color: theme.textSecondary,
      fontSize: 9,
      marginTop: 4,
      fontFamily: "monospace",
    },
    cardHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    cardTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    cardTitle: {
      fontSize: 14,
      fontWeight: "800",
      color: theme.textPrimary,
    },
    hzBadge: {
      backgroundColor: mode === "dark" ? "#162947" : "#E8F0FE",
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    hzText: {
      fontSize: 11,
      fontWeight: "800",
      color: theme.accent,
    },
    sensorSubtext: {
      fontSize: 10,
      color: theme.textSecondary,
      marginTop: 2,
      marginBottom: 8,
    },
    vectorRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      backgroundColor: theme.surfaceSubtle,
      borderRadius: 8,
      padding: 10,
    },
    axisItem: {
      alignItems: "center",
      flex: 1,
    },
    axisLabel: {
      fontSize: 10,
      color: theme.textMuted,
      fontWeight: "600",
    },
    axisValue: {
      fontSize: 13,
      fontWeight: "800",
      color: theme.textPrimary,
      marginTop: 2,
    },
    axisValueHighlight: {
      fontSize: 13,
      fontWeight: "800",
      color: theme.accent,
      marginTop: 2,
    },
    radSub: {
      fontSize: 9,
      color: theme.textMuted,
      marginTop: 1,
    },
    gnssGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      backgroundColor: theme.surfaceSubtle,
      borderRadius: 8,
      padding: 8,
      gap: 8,
    },
    gnssItem: {
      width: "48%",
    },
    gnssLabel: {
      fontSize: 10,
      color: theme.textMuted,
    },
    gnssValue: {
      fontSize: 12,
      fontWeight: "700",
      color: theme.textPrimary,
    },
    emptySessions: {
      fontSize: 12,
      color: theme.textMuted,
      marginTop: 6,
      fontStyle: "italic",
    },
    sessionRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.surfaceBorder,
    },
    sessionName: {
      fontSize: 12,
      fontWeight: "700",
      color: theme.textPrimary,
    },
    sessionMeta: {
      fontSize: 11,
      color: theme.textSecondary,
      marginTop: 1,
    },
    deleteBtn: {
      minWidth: 44,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    cardOutageActive: {
      borderColor: theme.danger,
      borderWidth: 1.5,
      backgroundColor: mode === "dark" ? "#2B1115" : "#FFF8F8",
    },
    gateStatusBox: {
      backgroundColor: theme.surfaceSubtle,
      borderRadius: 8,
      padding: 10,
      marginBottom: 10,
      gap: 6,
    },
    gateStatusRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    gateStatusLabel: {
      fontSize: 11,
      color: theme.textSecondary,
      fontWeight: "600",
    },
    gateStatusValue: {
      fontSize: 11,
      fontWeight: "800",
      color: theme.textPrimary,
    },
    gateButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      minHeight: 48,
      paddingVertical: 12,
      borderRadius: 8,
      gap: 8,
      marginTop: 10,
    },
    gateButtonActive: {
      backgroundColor: theme.danger,
    },
    gateButtonBlocked: {
      backgroundColor: theme.success,
    },
    gateButtonText: {
      fontSize: 13,
      fontWeight: "800",
      color: "#FFFFFF",
    },
  });
