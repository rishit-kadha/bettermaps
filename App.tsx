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
import { RoadDataOverlay } from "./src/components/ui/RoadDataOverlay";
import { SensorDiagnosticsModal } from "./src/components/sensors/SensorDiagnosticsModal";
import { sensorRecorderManager } from "./src/services/sensors/SensorRecorderManager";
import { navigationManager } from "./src/core/state/NavigationManager";
import { NavigationTelemetry } from "./src/core/types/navigation";
import { ThemeProvider, useTheme } from "./src/theme/ThemeContext";
import { iovnbdReplaySource } from "./src/services/replay/IovnbdReplaySource";
import { ReplayControlHUD } from "./src/components/replay/ReplayControlHUD";
import { OfflineRegionsModal } from "./src/components/ui/OfflineRegionsModal";
import {
  EvaluationMode,
  ExperimentMode,
  ReplaySpeed,
  ReplayTelemetry,
} from "./src/services/replay/types";
import { loadFixtureById } from "./src/services/replay/FixtureRegistry";
import { runMobileLatencyBenchmark } from "./src/services/replay/DeviceLatencyBenchmark";
import coventryRoadData from "./assets/datasets/road_network_coventry.json";

function AppContent() {
  const insets = useSafeAreaInsets();
  const { theme, mode } = useTheme();
  const [telemetry, setTelemetry] = useState<NavigationTelemetry>(() =>
    navigationManager.getTelemetry(),
  );
  const [diagnosticsOpen, setDiagnosticsOpen] = useState<boolean>(false);
  const [sensorsModalOpen, setSensorsModalOpen] = useState<boolean>(false);
  const [isSensorRecording, setIsSensorRecording] = useState<boolean>(false);
  const [offlineRegionsOpen, setOfflineRegionsOpen] = useState<boolean>(false);

  // Replay Laboratory State (Phase 4 Testing Harness)
  const [isReplayLabOpen, setIsReplayLabOpen] = useState<boolean>(false);
  const [replayTelemetry, setReplayTelemetry] = useState<ReplayTelemetry>(() =>
    iovnbdReplaySource.getTelemetry(),
  );
  const [isReferenceVisible, setIsReferenceVisible] = useState<boolean>(true);
  const [isEstimatedVisible, setIsEstimatedVisible] = useState<boolean>(true);

  // Road-data debug overlay state
  const [showRoadCoverageDebug, setShowRoadCoverageDebug] = useState<boolean>(false);
  const [roadUpdateCount, setRoadUpdateCount] = useState<number>(0);
  const [routeUpdateCount, setRouteUpdateCount] = useState<number>(0);

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

    // 2b. Connect RoadDataManager to Replay source for dynamic prefetch
    const roadMgr = navigationManager.getRoadDataManager();
    if (roadMgr) {
      iovnbdReplaySource.setRoadDataManager(roadMgr);
    }

    // 2c. Listen to road data changes to re-render cached road layer
    let unsubRoadData: (() => void) | undefined;
    if (roadMgr?.addRoadDataListener) {
      unsubRoadData = roadMgr.addRoadDataListener(() => {
        setRoadUpdateCount((prev) => prev + 1);
      });
    }

    // 3. Listen to sensor recording status
    const unsubSensors = sensorRecorderManager.addTelemetryListener((tel) => {
      setIsSensorRecording(tel.recording.isRecording);
    });

    return () => {
      unsubReplay();
      unsubscribe();
      unsubRoadData?.();
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

  // Poll estimator for road/route update counts every 1s (DEV diagnostic only)
  useEffect(() => {
    if (!__DEV__) return;
    const id = setInterval(() => {
      const engine = navigationManager.getPositioningEngine() as any;
      setRoadUpdateCount(engine?.getRoadUpdateCount?.() ?? 0);
      setRouteUpdateCount(engine?.getRouteUpdateCount?.() ?? 0);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Automated Physical Device Evaluation Bridge (Active in __DEV__)
  useEffect(() => {
    if (!__DEV__) return;
    let cancelled = false;

    const pollBridge = async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500);
        const resp = await fetch("http://127.0.0.1:8088/poll", {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (resp.ok && resp.status === 200) {
          const cmd = await resp.json();
          if (cmd && cmd.id && cmd.action) {
            let result: any = { status: "ack" };
            try {
              if (cmd.action === "OPEN_DIAGNOSTICS") {
                setDiagnosticsOpen(true);
                result = {
                  status: "opened",
                  telemetry: navigationManager.getTelemetry(),
                };
              } else if (cmd.action === "CLOSE_DIAGNOSTICS") {
                setDiagnosticsOpen(false);
                result = { status: "closed" };
              } else if (cmd.action === "OPEN_LAB") {
                setIsReplayLabOpen(true);
                navigationManager.getRoadDataManager()?.setSourcePosition("REPLAY");
                navigationManager.setNavigationMode("follow_course");
                result = { status: "opened" };
              } else if (cmd.action === "CLOSE_LAB") {
                setIsReplayLabOpen(false);
                navigationManager.getRoadDataManager()?.setSourcePosition("LIVE");
                iovnbdReplaySource.pause();
                result = { status: "closed" };
              } else if (cmd.action === "OPEN_OFFLINE_REGIONS") {
                setOfflineRegionsOpen(true);
                result = { status: "opened" };
              } else if (cmd.action === "CLOSE_OFFLINE_REGIONS") {
                setOfflineRegionsOpen(false);
                result = { status: "closed" };
              } else if (cmd.action === "LOAD_FIXTURE") {
                let fixtureData = cmd.fixture;
                if (!fixtureData && cmd.session) {
                  const fResp = await fetch(
                    `http://127.0.0.1:8088/fixture?session=${cmd.session}`,
                  );
                  if (fResp.ok) {
                    fixtureData = await fResp.json();
                  }
                }
                if (fixtureData) {
                  iovnbdReplaySource.loadFixture(fixtureData);
                  setIsReplayLabOpen(true);
                  navigationManager.setNavigationMode("follow_course");
                  result = {
                    status: "loaded",
                    session: fixtureData.metadata?.session_id,
                    samples: fixtureData.samples?.length,
                  };
                } else {
                  result = { status: "error", error: "Failed to load fixture" };
                }
              } else if (cmd.action === "SET_CONFIG") {
                if (cmd.speed !== undefined)
                  iovnbdReplaySource.setSpeed(cmd.speed);
                if (cmd.mode !== undefined)
                  iovnbdReplaySource.setExperimentMode(cmd.mode);
                if (cmd.evaluationMode !== undefined)
                  iovnbdReplaySource.setEvaluationMode(cmd.evaluationMode);
                if (
                  cmd.outageStartSec !== undefined &&
                  cmd.outageDurationSec !== undefined
                ) {
                  iovnbdReplaySource.setOutageInterval(
                    cmd.outageStartSec,
                    cmd.outageDurationSec,
                  );
                }
                if (cmd.modelBackend !== undefined) {
                  iovnbdReplaySource.setModelBackend(cmd.modelBackend);
                }
                result = { status: "configured" };
              } else if (cmd.action === "PLAY") {
                iovnbdReplaySource.play();
                result = { status: "playing" };
              } else if (cmd.action === "PAUSE") {
                iovnbdReplaySource.pause();
                result = { status: "paused" };
              } else if (cmd.action === "RESET") {
                iovnbdReplaySource.reset();
                result = { status: "reset" };
              } else if (cmd.action === "GET_STATUS") {
                result = {
                  telemetry: iovnbdReplaySource.getTelemetry(),
                  report: iovnbdReplaySource.getDetailedReport(),
                };
              } else if (cmd.action === "GET_TRAJECTORY") {
                result = {
                  session: iovnbdReplaySource.getSessionId(),
                  referenceHistory: iovnbdReplaySource.getReferenceHistory(),
                  estimatedHistory: iovnbdReplaySource.getEstimatedHistory(),
                };
              } else if (cmd.action === "RUN_BENCHMARK") {
                const benchResults = runMobileLatencyBenchmark(cmd.ticks || 2000);
                result = { status: "success", benchmark: benchResults };
              } else if (cmd.action === "GET_LIVE_STATUS") {
                const engine = navigationManager.getPositioningEngine() as any;
                const roadMgr = navigationManager.getRoadDataManager?.() ?? null;
                result = {
                  status: "live_status",
                  telemetry: navigationManager.getTelemetry(),
                  gateState: navigationManager.getGate?.()?.getState?.() ?? "GNSS_STREAM_ENABLED",
                  roadUpdateCount: engine?.getRoadUpdateCount?.() ?? 0,
                  routeUpdateCount: engine?.getRouteUpdateCount?.() ?? 0,
                  gnssDeliveredCount: engine?.getGnssDeliveredCount?.() ?? 0,
                  roadDataManagerDiagnostics: roadMgr?.getDiagnostics?.() ?? null,
                };
              } else if (cmd.action === "SET_LIVE_CONFIG") {
                if (cmd.gateState !== undefined) {
                  const mapped = (cmd.gateState === "open" || cmd.gateState === "GNSS_STREAM_ENABLED")
                    ? "GNSS_STREAM_ENABLED"
                    : "GNSS_STREAM_DISABLED";
                  navigationManager.setGnssStreamGate(mapped);
                }
                const engine = navigationManager.getPositioningEngine() as any;
                if (cmd.roadConstraintEnabled !== undefined && engine?.getRoadConstraint) {
                  engine.getRoadConstraint()?.setEnabled(cmd.roadConstraintEnabled);
                }
                if (cmd.routeConstraintEnabled !== undefined && engine?.getRouteConstraint) {
                  engine.getRouteConstraint()?.setEnabled(cmd.routeConstraintEnabled);
                }
                if (cmd.mode !== undefined) {
                  navigationManager.setNavigationMode(cmd.mode);
                }
                result = {
                  status: "configured",
                  gateState: navigationManager.getGate?.()?.getState?.() ?? "GNSS_STREAM_ENABLED",
                  roadConstraintEnabled: engine?.getRoadConstraint?.()?.getEnabled?.() ?? null,
                  routeConstraintEnabled: engine?.getRouteConstraint?.()?.getEnabled?.() ?? null,
                };
              } else if (cmd.action === "SET_LIVE_ROUTE") {
                if (cmd.route) {
                  const normalizedRoute = cmd.route.geometry
                    ? cmd.route
                    : {
                        metadata: cmd.route.metadata ?? {
                          id: "test-route",
                          totalDistanceMeters: 1000,
                          estimatedDurationSeconds: 100,
                          source: "test",
                        },
                        geometry: {
                          points: cmd.route.points ?? cmd.route.geometry?.points ?? [],
                        },
                        legs: cmd.route.legs ?? [],
                      };
                  navigationManager.setRoutePreview(normalizedRoute);
                  navigationManager.startNavigation();
                  result = { status: "route_started", routeId: normalizedRoute.metadata?.id };
                } else {
                  navigationManager.stopNavigation();
                  result = { status: "route_stopped" };
                }
              } else if (cmd.action === "SWITCH_LIVE_PROVIDER") {
                if (cmd.providerId) {
                  await navigationManager.switchProvider(cmd.providerId);
                  result = { status: "switched", providerId: cmd.providerId };
                }
              } else if (cmd.action === "INJECT_LIVE_IMU") {
                if (cmd.sample) {
                  const engine = navigationManager.getPositioningEngine() as any;
                  const est = engine?.processImu?.(cmd.sample);
                  result = { status: "injected", estimate: est };
                }
              } else if (cmd.action === "INJECT_LIVE_GNSS") {
                if (cmd.location) {
                  const engine = navigationManager.getPositioningEngine() as any;
                  const est = engine?.processGnss?.(cmd.location);
                  result = { status: "injected", estimate: est };
                }
              }
            } catch (cmdErr) {
              result = { status: "error", error: String(cmdErr) };
            }

            await fetch("http://127.0.0.1:8088/respond", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: cmd.id, result }),
            });
          }
        }
      } catch (_err) {
        // Dev server idle or not connected - ignore
      }
      if (!cancelled) {
        setTimeout(pollBridge, 250);
      }
    };

    pollBridge();
    return () => {
      cancelled = true;
    };
  }, []);

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
      const roadMgr = navigationManager.getRoadDataManager();
      if (next) {
        roadMgr?.setSourcePosition("REPLAY");
        navigationManager.setNavigationMode("follow_course");
      } else {
        roadMgr?.setSourcePosition("LIVE");
        iovnbdReplaySource.pause();
      }
      return next;
    });
  };

  const handleCloseReplayLab = () => {
    navigationManager.getRoadDataManager()?.setSourcePosition("LIVE");
    iovnbdReplaySource.pause();
    setShowRoadCoverageDebug(false);
    setIsReplayLabOpen(false);
  };

  const handleSelectSession = (sessionId: string) => {
    try {
      iovnbdReplaySource.pause();
      iovnbdReplaySource.reset();
      setShowRoadCoverageDebug(false);
      const fixture = loadFixtureById(sessionId);
      iovnbdReplaySource.loadFixture(fixture);
    } catch (err) {
      console.error("[App] Failed to load session fixture:", err);
    }
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

  // Debug road-graph segments — only materialized when the overlay is toggled on
  const debugRoadSegments = React.useMemo(() => {
    if (!showRoadCoverageDebug) return [];

    const roadMgr = isReplayLabOpen
      ? (iovnbdReplaySource.getRoadDataManager() ?? navigationManager.getRoadDataManager())
      : navigationManager.getRoadDataManager();

    const provider = roadMgr?.getRoadNetworkProvider() as any;
    const segments = provider?.getAllSegments?.() ?? [];
    if (segments && segments.length > 0) {
      return segments;
    }

    // In Replay mode, if provider has not loaded tiles yet, fallback to bundled Coventry road network
    if (isReplayLabOpen && coventryRoadData && (coventryRoadData as any).segments) {
      return (coventryRoadData as any).segments;
    }

    return [];
  }, [
    showRoadCoverageDebug,
    isReplayLabOpen,
    roadUpdateCount,
    telemetry.roadDiagnostics?.loadedTileCount,
    replayTelemetry.roadCoverageDiagnostics?.loadedTileCount,
  ]);

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
          isReplayLabOpen ? replayTelemetry.referenceTrail : undefined
        }
        estimatedTrail={
          isReplayLabOpen ? replayTelemetry.estimatedTrail : undefined
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
        activeRoute={
          isReplayLabOpen
            ? iovnbdReplaySource.getReplayRoute()
            : telemetry.activeRoute
        }
        navigationStatus={
          isReplayLabOpen ? "navigating" : telemetry.navigationStatus
        }
        onUserPan={handleUserPan}
        loadedRoadSegments={debugRoadSegments}
        showRoadCoverageDebug={showRoadCoverageDebug}
        isReplayActive={isReplayLabOpen}
      />

      {/* Road-data Coverage Debug Overlay (DEV only) */}
      {__DEV__ && (
        <RoadDataOverlay
          roadDiagnostics={telemetry.roadDiagnostics}
          roadUpdateCount={roadUpdateCount}
          routeUpdateCount={routeUpdateCount}
          showRoadCoverage={showRoadCoverageDebug}
          onToggleRoadCoverage={() => setShowRoadCoverageDebug((prev) => !prev)}
          visible={__DEV__}
        />
      )}

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
          onOpenOfflineRegions={() => setOfflineRegionsOpen(true)}
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
          onReset={() => {
            iovnbdReplaySource.reset();
            setShowRoadCoverageDebug(false);
          }}
          onSetSpeed={(s: ReplaySpeed) => iovnbdReplaySource.setSpeed(s)}
          onSetMode={(m: ExperimentMode) =>
            iovnbdReplaySource.setExperimentMode(m)
          }
          onSelectEvaluationMode={(em: EvaluationMode) =>
            iovnbdReplaySource.setEvaluationMode(em)
          }
          onSelectModelBackend={(b) => iovnbdReplaySource.setModelBackend(b)}
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
          isRoadLayerVisible={showRoadCoverageDebug}
          onToggleRoadLayer={() => setShowRoadCoverageDebug((prev) => !prev)}
          onClose={handleCloseReplayLab}
          onSelectSession={handleSelectSession}
        />
      )}

      {/* 10. Diagnostics Panel Modal Sheet */}
      <DiagnosticsPanel
        telemetry={telemetry}
        replayTelemetry={isReplayLabOpen ? replayTelemetry : undefined}
        visible={diagnosticsOpen}
        onClose={() => setDiagnosticsOpen(false)}
      />

      {/* 11. Sensor Diagnostics & High-Rate Recorder Modal */}
      <SensorDiagnosticsModal
        visible={sensorsModalOpen}
        onClose={() => setSensorsModalOpen(false)}
        currentLocation={telemetry.currentLocation}
      />

      {/* 12. Offline Regional Map Packs Modal */}
      <OfflineRegionsModal
        visible={offlineRegionsOpen}
        onClose={() => setOfflineRegionsOpen(false)}
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
