import { StatusBar } from "expo-status-bar";
import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { AvailableProviderId } from "./src/adapters/location";
import { MapContainer } from "./src/components/map/MapContainer";
import { TopHeaderStack } from "./src/components/navigation/TopHeaderStack";
import { NavigationActiveHUD } from "./src/components/navigation/NavigationActiveHUD";
import { NavigationManeuverBanner } from "./src/components/navigation/NavigationManeuverBanner";
import { RoutePreviewCard } from "./src/components/navigation/RoutePreviewCard";
import { BottomHUD } from "./src/components/navigation/BottomHUD";
import { MapControls } from "./src/components/navigation/MapControls";
import { SystemWarningBanner } from "./src/components/navigation/SystemWarningBanner";
import { DiagnosticsPanel } from "./src/components/ui/DiagnosticsPanel";
import { SensorDiagnosticsModal } from "./src/components/sensors/SensorDiagnosticsModal";
import { sensorRecorderManager } from "./src/services/sensors/SensorRecorderManager";
import { navigationManager } from "./src/core/state/NavigationManager";
import { NavigationTelemetry } from "./src/core/types/navigation";
import { ThemeProvider, useTheme } from "./src/theme/ThemeContext";
import { iovnbdReplaySource } from "./src/services/replay/IovnbdReplaySource";
import { ReplayControlHUD } from "./src/components/replay/ReplayControlHUD";
import {
  ExperimentMode,
  ReplaySpeed,
  ReplayTelemetry,
} from "./src/services/replay/types";

function AppContent() {
  const insets = useSafeAreaInsets();
  const { theme, mode } = useTheme();
  const [telemetry, setTelemetry] = useState<NavigationTelemetry>(() =>
    navigationManager.getTelemetry(),
  );
  const [diagnosticsOpen, setDiagnosticsOpen] = useState<boolean>(false);
  const [sensorsModalOpen, setSensorsModalOpen] = useState<boolean>(false);
  const [isSensorRecording, setIsSensorRecording] = useState<boolean>(false);

  // Replay Laboratory State (Phase 4 Testing Harness)
  const [isReplayLabOpen, setIsReplayLabOpen] = useState<boolean>(false);
  const [replayTelemetry, setReplayTelemetry] = useState<ReplayTelemetry>(() =>
    iovnbdReplaySource.getTelemetry(),
  );
  const [isReferenceVisible, setIsReferenceVisible] = useState<boolean>(true);
  const [isEstimatedVisible, setIsEstimatedVisible] = useState<boolean>(true);

  useEffect(() => {
    // 0. Subscribe to IO-VNBD Replay Harness stream
    const unsubReplay = iovnbdReplaySource.addTelemetryListener((tel) => {
      setReplayTelemetry(tel);
    });
    const unsubscribe = navigationManager.subscribeTelemetry(
      (updatedTelemetry) => {
        setTelemetry(updatedTelemetry);
      },
    );

    // 2. Start platform location engine
    navigationManager.start().catch((err) => {
      console.error("Failed to start navigation engine:", err);
    });

    // 3. Listen to sensor recording status
    const unsubSensors = sensorRecorderManager.addTelemetryListener((tel) => {
      setIsSensorRecording(tel.recording.isRecording);
    });

    return () => {
      unsubReplay();
      unsubscribe();
      unsubSensors();
      navigationManager.stop().catch(() => {});
    };
  }, []);

  // Forward location updates to sensor recorder if active session exists
  useEffect(() => {
    if (telemetry.currentLocation) {
      sensorRecorderManager.recordGnssLocation(telemetry.currentLocation);
    }
  }, [telemetry.currentLocation]);

  const handleSwitchProvider = async () => {
    const nextId: AvailableProviderId =
      telemetry.providerType === "gnss" ? "mock" : "native_gnss";
    await navigationManager.switchProvider(nextId);
  };

  const handleRecenter = () => {
    navigationManager.recenter();
  };

  const handleToggleCompass = () => {
    navigationManager.toggleNavigationMode();
  };

  const handleTogglePerspective = () => {
    navigationManager.toggleCameraPerspective();
  };

  const handleToggleDiagnostics = () => {
    setDiagnosticsOpen((prev) => !prev);
  };

  const handleRequestPermission = async () => {
    await navigationManager.requestPermissions();
  };

  const handleUserPan = () => {
    if (telemetry.mode !== "free") {
      navigationManager.setNavigationMode("free");
    }
  };

  const handleToggleReplayLab = () => {
    setIsReplayLabOpen((prev) => {
      const next = !prev;
      if (next) {
        navigationManager.setNavigationMode("follow_course");
      } else {
        iovnbdReplaySource.pause();
      }
      return next;
    });
  };

  const handleCloseReplayLab = () => {
    iovnbdReplaySource.pause();
    setIsReplayLabOpen(false);
  };

  const replayLocation = isReplayLabOpen
    ? iovnbdReplaySource.getCurrentEstimatedLocation()
    : null;

  const activeLocation = isReplayLabOpen
    ? replayLocation
    : telemetry.currentLocation;

  const activeHeading = isReplayLabOpen
    ? (replayLocation?.heading ?? 0)
    : telemetry.smoothedHeading;

  const activeIsDeadReckoning = isReplayLabOpen
    ? replayTelemetry.isDeadReckoning
    : telemetry.isDeadReckoning;

  const isNavigating =
    telemetry.navigationStatus === "navigating" ||
    telemetry.navigationStatus === "arrived";

  const isRoutePreview =
    telemetry.navigationStatus === "route_preview" && !!telemetry.activeRoute;

  const isSearchingOrIdle =
    telemetry.navigationStatus === "idle" ||
    telemetry.navigationStatus === "searching";

  const isOutageActive =
    telemetry.gnssStreamGateState === "GNSS_STREAM_DISABLED";

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <StatusBar style={mode === "dark" ? "light" : "dark"} />

      {/* 1. Map Layer: Edge-to-edge Google Maps rendering */}
      <MapContainer
        location={activeLocation}
        heading={activeHeading}
        isHeadingReliable={isReplayLabOpen ? true : telemetry.isHeadingReliable}
        mode={telemetry.mode}
        cameraPerspective={telemetry.cameraPerspective}
        isDeadReckoning={activeIsDeadReckoning}
        historyTrail={isReplayLabOpen ? [] : telemetry.historyTrail}
        referenceTrail={
          isReplayLabOpen ? iovnbdReplaySource.getReferenceHistory() : undefined
        }
        estimatedTrail={
          isReplayLabOpen ? iovnbdReplaySource.getEstimatedHistory() : undefined
        }
        referenceLocation={
          isReplayLabOpen && replayTelemetry.referenceCoordinate
            ? {
                latitude: replayTelemetry.referenceCoordinate.latitude,
                longitude: replayTelemetry.referenceCoordinate.longitude,
              }
            : null
        }
        isReferenceVisible={isReferenceVisible}
        isEstimatedVisible={isEstimatedVisible}
        activeRoute={isReplayLabOpen ? null : telemetry.activeRoute}
        navigationStatus={
          isReplayLabOpen ? "navigating" : telemetry.navigationStatus
        }
        onUserPan={handleUserPan}
      />

      {/* 2. Top Maneuver Banner (Active Navigation Mode) */}
      {!isReplayLabOpen && isNavigating && (
        <NavigationManeuverBanner
          progress={telemetry.routeProgress}
          isArrived={telemetry.navigationStatus === "arrived"}
        />
      )}

      {/* 3. Top Header Stack: Search Bar + Control Pills (Idle / Search Mode) */}
      {!isReplayLabOpen && isSearchingOrIdle && (
        <TopHeaderStack
          currentLocation={
            telemetry.currentLocation
              ? {
                  latitude: telemetry.currentLocation.latitude,
                  longitude: telemetry.currentLocation.longitude,
                }
              : null
          }
          telemetry={telemetry}
          diagnosticsOpen={diagnosticsOpen}
          isSensorRecording={isSensorRecording}
          onToggleDiagnostics={handleToggleDiagnostics}
          onSwitchProvider={handleSwitchProvider}
          onOpenSensors={() => setSensorsModalOpen(true)}
        />
      )}

      {/* 4. Route Error Notice Banner */}
      {!isReplayLabOpen && telemetry.routeError && (
        <View
          style={[
            styles.routeErrorBanner,
            {
              top: Math.max(insets.top, 16) + 168,
              backgroundColor: theme.dangerSurface,
              borderColor: theme.danger,
            },
          ]}
        >
          <Ionicons name="alert-circle" size={20} color={theme.danger} />
          <Text style={[styles.routeErrorText, { color: theme.dangerText }]}>
            {telemetry.routeError}
          </Text>
          <TouchableOpacity
            onPress={() => navigationManager.setRouteError(null)}
            style={styles.dismissButton}
          >
            <Ionicons name="close" size={18} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {/* 5. System Warning Banners (Permissions, GPS, Simulated Outage) */}
      {!isReplayLabOpen && (
        <SystemWarningBanner
          providerStatus={telemetry.providerStatus}
          isOutageActive={isOutageActive}
          onRequestPermission={handleRequestPermission}
          topOffset={Math.max(insets.top, 16) + 168}
        />
      )}

      {/* 6. Independent Map Controls (Right-side FAB group) */}
      <MapControls
        mode={telemetry.mode}
        cameraPerspective={telemetry.cameraPerspective}
        smoothedHeading={telemetry.smoothedHeading}
        isSensorRecording={isSensorRecording}
        isReplayActive={isReplayLabOpen}
        onToggleReplay={handleToggleReplayLab}
        bottomOffset={
          isRoutePreview || (isNavigating && !isReplayLabOpen)
            ? Math.max(insets.bottom, 12) + 190
            : Math.max(insets.bottom, 12) + 16
        }
        onOpenSensors={() => setSensorsModalOpen(true)}
        onTogglePerspective={handleTogglePerspective}
        onToggleCompass={handleToggleCompass}
        onRecenter={handleRecenter}
      />

      {/* 7. Route Preview Bottom Card (Route Overview Mode) */}
      {!isReplayLabOpen && isRoutePreview && telemetry.activeRoute && (
        <RoutePreviewCard
          route={telemetry.activeRoute}
          onStart={() => navigationManager.startNavigation()}
          onCancel={() => navigationManager.stopNavigation()}
        />
      )}

      {/* 8. Active Driving Navigation Bottom HUD */}
      {!isReplayLabOpen && isNavigating && telemetry.activeRoute && (
        <NavigationActiveHUD
          route={telemetry.activeRoute}
          progress={telemetry.routeProgress}
          speedKmh={telemetry.speedKmh}
          heading={telemetry.smoothedHeading}
          locationSource={telemetry.locationSource}
          onExit={() => navigationManager.stopNavigation()}
        />
      )}

      {/* 9. Vehicle Status & Telemetry Bottom HUD (Contextual: only during active driving if no route HUD) */}
      {!isReplayLabOpen && isNavigating && !telemetry.activeRoute && (
        <BottomHUD telemetry={telemetry} />
      )}

      {/* 10. IO-VNBD Replay Control HUD (Phase 4 Testing Harness) */}
      {isReplayLabOpen && (
        <ReplayControlHUD
          telemetry={replayTelemetry}
          onPlay={() => iovnbdReplaySource.play()}
          onPause={() => iovnbdReplaySource.pause()}
          onReset={() => iovnbdReplaySource.reset()}
          onSetSpeed={(s: ReplaySpeed) => iovnbdReplaySource.setSpeed(s)}
          onSetMode={(m: ExperimentMode) =>
            iovnbdReplaySource.setExperimentMode(m)
          }
          onToggleRouteConstraint={() =>
            iovnbdReplaySource.toggleRouteConstraint()
          }
          onToggleReferenceVisible={() =>
            setIsReferenceVisible((prev) => !prev)
          }
          onToggleEstimatedVisible={() =>
            setIsEstimatedVisible((prev) => !prev)
          }
          isReferenceVisible={isReferenceVisible}
          isEstimatedVisible={isEstimatedVisible}
          onClose={handleCloseReplayLab}
        />
      )}

      {/* 10. Diagnostics Panel Modal Sheet */}
      <DiagnosticsPanel
        telemetry={telemetry}
        visible={diagnosticsOpen}
        onClose={() => setDiagnosticsOpen(false)}
      />

      {/* 11. Sensor Diagnostics & High-Rate Recorder Modal */}
      <SensorDiagnosticsModal
        visible={sensorsModalOpen}
        onClose={() => setSensorsModalOpen(false)}
        currentLocation={telemetry.currentLocation}
      />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider initialMode="dark">
        <AppContent />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F8F9FA",
  },
  routeErrorBanner: {
    position: "absolute",
    left: 16,
    right: 16,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    zIndex: 95,
    borderWidth: 1,
  },
  routeErrorText: {
    flex: 1,
    fontSize: 12,
    marginHorizontal: 8,
    lineHeight: 16,
  },
  dismissButton: {
    padding: 4,
  },
});
