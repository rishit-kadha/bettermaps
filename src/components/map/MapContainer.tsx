import React, { useEffect, useRef } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import MapView, {
  Marker,
  Polyline,
  PROVIDER_DEFAULT,
  PROVIDER_GOOGLE,
} from "react-native-maps";
import { NavLocation } from "../../core/types/location";
import {
  ActiveRoute,
  CameraPerspective,
  NavigationMode,
  NavigationStatus,
} from "../../core/types/navigation";
import { VehicleMarker } from "./VehicleMarker";
import {
  darkMapStyle,
  lightMapStyle,
  useTheme,
} from "../../theme/ThemeContext";

export interface MapContainerProps {
  location: NavLocation | null;
  heading: number;
  isHeadingReliable: boolean;
  mode: NavigationMode;
  cameraPerspective?: CameraPerspective;
  isDeadReckoning?: boolean;
  historyTrail: { latitude: number; longitude: number }[];
  activeRoute?: ActiveRoute | null;
  navigationStatus?: NavigationStatus;
  onUserPan: () => void;
  // Replay harness extensions
  referenceTrail?: { latitude: number; longitude: number }[];
  estimatedTrail?: { latitude: number; longitude: number }[];
  referenceLocation?: { latitude: number; longitude: number } | null;
  isReferenceVisible?: boolean;
  isEstimatedVisible?: boolean;
  // Road-graph debug overlay (Fix 4 & 5)
  loadedRoadSegments?: Array<{
    id?: string;
    startPoint: { latitude: number; longitude: number };
    endPoint: { latitude: number; longitude: number };
    geometry?: Array<{ latitude: number; longitude: number }>;
  }>;
  showRoadCoverageDebug?: boolean;
  /** True when the Replay Lab is open — uses shorter camera animation to reduce
   *  contention with user pan gestures during 30 Hz replay playback. */
  isReplayActive?: boolean;
}

export const MapContainer: React.FC<MapContainerProps> = ({
  location,
  heading,
  isHeadingReliable,
  mode,
  cameraPerspective = "2D",
  isDeadReckoning = false,
  historyTrail,
  activeRoute,
  navigationStatus = "idle",
  onUserPan,
  referenceTrail,
  estimatedTrail,
  referenceLocation,
  isReferenceVisible = true,
  isEstimatedVisible = true,
  loadedRoadSegments,
  showRoadCoverageDebug = false,
  isReplayActive = false,
}) => {
  const mapRef = useRef<MapView | null>(null);
  const prevStatusRef = useRef<NavigationStatus>(navigationStatus);
  const lastCameraAnimateMs = useRef<number>(0);
  const lastCameraLat = useRef<number>(0);
  const lastCameraLon = useRef<number>(0);
  const lastCameraHeading = useRef<number>(0);

  // Default initial viewport — Coventry city centre (Fix 1)
  const defaultRegion = {
    latitude: 52.408,
    longitude: -1.512,
    latitudeDelta: 0.02,
    longitudeDelta: 0.02,
  };

  // 1. Route Preview: Automatically frame the whole route bounding box
  useEffect(() => {
    if (
      navigationStatus === "route_preview" &&
      activeRoute &&
      activeRoute.geometry.points.length >= 2 &&
      mapRef.current
    ) {
      mapRef.current.fitToCoordinates(activeRoute.geometry.points, {
        edgePadding: { top: 120, bottom: 220, left: 60, right: 60 },
        animated: true,
      });
    }
  }, [navigationStatus, activeRoute?.metadata.id]);

  // 2. Dynamic Camera Tracking (Driving follow mode or Free mode)
  // Fix 2: When dead-reckoning is active, camera always follows regardless of
  // free-pan mode so IDR position stays centred during a GNSS outage.
  useEffect(() => {
    if (!location || !mapRef.current) return;
    if (navigationStatus === "route_preview") return; // Keep route overview framed

    // During dead reckoning, override user-pan mode and always follow the
    // IDR position so the map doesn't drift away during a GNSS outage.
    if (mode === "free" && !isDeadReckoning) return;

    const targetHeading = mode === "follow_course" && isHeadingReliable ? heading : 0;
    const now = Date.now();
    const timeDelta = now - lastCameraAnimateMs.current;

    // Calculate displacement from last camera target
    const dLat = (location.latitude - lastCameraLat.current) * 111139;
    const cosLat = Math.cos((location.latitude * Math.PI) / 180);
    const dLon = (location.longitude - lastCameraLon.current) * 111139 * cosLat;
    const distSq = dLat * dLat + dLon * dLon;

    let headingDiff = Math.abs(targetHeading - lastCameraHeading.current);
    if (headingDiff > 180) headingDiff = 360 - headingDiff;

    // Throttle camera animation updates:
    // Only animate if >= 100ms elapsed AND (moved >= 1.0m OR heading changed >= 2.5 deg)
    const statusChanged = prevStatusRef.current !== navigationStatus;
    if (!statusChanged && timeDelta < 100 && distSq < 1.0 && headingDiff < 2.5) {
      return;
    }

    lastCameraAnimateMs.current = now;
    lastCameraLat.current = location.latitude;
    lastCameraLon.current = location.longitude;
    lastCameraHeading.current = targetHeading;
    prevStatusRef.current = navigationStatus;

    const isNavigating = navigationStatus === "navigating";
    const is3D = cameraPerspective === "3D";

    const cameraConfig = {
      center: {
        latitude: location.latitude,
        longitude: location.longitude,
      },
      zoom: isNavigating ? (is3D ? 19 : 18.5) : 18,
      heading: targetHeading,
      pitch: is3D && mode === "follow_course" ? (isNavigating ? 50 : 45) : 0,
      altitude: is3D ? (isNavigating ? 140 : 200) : 300,
    };

    mapRef.current.animateCamera(cameraConfig, { duration: isReplayActive ? 50 : 150 });
  }, [
    location?.latitude,
    location?.longitude,
    heading,
    isHeadingReliable,
    mode,
    cameraPerspective,
    navigationStatus,
    isDeadReckoning,
    isReplayActive,
  ]);

  // 3. Stop any in-flight camera animation immediately when mode transitions to "free".
  // Without this, a 150ms animateCamera() dispatched just before the user panned
  // would complete and snap the map back to the vehicle, making free mode appear broken.
  const prevModeRef = useRef<NavigationMode>(mode);
  useEffect(() => {
    if (mode === "free" && prevModeRef.current !== "free" && mapRef.current) {
      (mapRef.current as any).stopAnimation?.();
    }
    prevModeRef.current = mode;
  }, [mode]);

  const mapProvider =
    Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT;

  const { theme, mode: themeMode } = useTheme();

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={mapProvider}
        style={styles.map}
        initialRegion={defaultRegion}
        customMapStyle={themeMode === "dark" ? darkMapStyle : lightMapStyle}
        userInterfaceStyle={themeMode}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        showsTraffic={false}
        showsBuildings={true}
        rotateEnabled={true}
        pitchEnabled={true}
        onPanDrag={onUserPan}
      >
        {/* Active Navigation Route Polyline */}
        {activeRoute && activeRoute.geometry.points.length >= 2 && (
          <>
            <Polyline
              coordinates={activeRoute.geometry.points}
              strokeColor={theme.routePolylineBorder}
              strokeWidth={8}
              lineCap="round"
              lineJoin="round"
            />
            <Polyline
              coordinates={activeRoute.geometry.points}
              strokeColor={theme.routePolylineCore}
              strokeWidth={6}
              lineCap="round"
              lineJoin="round"
            />
          </>
        )}

        {/* Trajectory Breadcrumb Polyline */}
        {navigationStatus !== "navigating" && historyTrail.length > 1 && (
          <Polyline
            coordinates={historyTrail}
            strokeColor={
              isDeadReckoning
                ? "rgba(255, 152, 0, 0.6)"
                : theme.historyTrailColor
            }
            strokeWidth={4}
            lineCap="round"
            lineJoin="round"
          />
        )}

        {/* Destination Marker — Fix 3: guard against undefined destinationCoordinate */}
        {activeRoute &&
          activeRoute.metadata?.destinationCoordinate?.latitude !== undefined && (
            <Marker
              coordinate={activeRoute.metadata.destinationCoordinate}
              anchor={{ x: 0.5, y: 1.0 }}
              title={activeRoute.metadata.destinationName}
              description={activeRoute.metadata.destinationAddress}
            >
              <View style={styles.destinationPin}>
                <Ionicons name="location" size={38} color="#EA4335" />
              </View>
            </Marker>
          )}

        {/* Replay Reference Trail */}
        {isReferenceVisible && referenceTrail && referenceTrail.length > 1 && (
          <Polyline
            coordinates={referenceTrail}
            strokeColor="#00E5FF"
            strokeWidth={4}
            lineDashPattern={[8, 4]}
            lineCap="round"
            lineJoin="round"
            zIndex={60}
          />
        )}

        {/* Replay Estimated IDR Trail */}
        {isEstimatedVisible && estimatedTrail && estimatedTrail.length > 1 && (
          <Polyline
            coordinates={estimatedTrail}
            strokeColor="#FF9100"
            strokeWidth={4}
            lineCap="round"
            lineJoin="round"
            zIndex={70}
          />
        )}

        {/* Replay Reference Position Marker */}
        {isReferenceVisible && referenceLocation && (
          <Marker
            coordinate={{
              latitude: referenceLocation.latitude,
              longitude: referenceLocation.longitude,
            }}
            anchor={{ x: 0.5, y: 0.5 }}
            flat={false}
            tracksViewChanges={true}
            zIndex={85}
          >
            <View style={styles.referenceMarker}>
              <View style={styles.referenceDot} />
              <Text style={styles.referenceLabel}>REF</Text>
            </View>
          </Marker>
        )}

        {/* Estimator Road-Graph Debug Layer — Fix 5 */}
        {/* Renders the actual road segments loaded into RoadDataManager / LocalRoadNetworkProvider. */}
        {/* These are NOT Google Maps roads — they are the estimator's internal cached graph. */}
        {showRoadCoverageDebug &&
          loadedRoadSegments &&
          loadedRoadSegments.length > 0 &&
          loadedRoadSegments
            .map((seg, idx) => {
              const rawCoords =
                seg.geometry && seg.geometry.length >= 2
                  ? seg.geometry
                  : [seg.startPoint, seg.endPoint];
              const validCoords = rawCoords.filter(
                (pt) =>
                  pt &&
                  typeof pt.latitude === "number" &&
                  typeof pt.longitude === "number" &&
                  !isNaN(pt.latitude) &&
                  !isNaN(pt.longitude) &&
                  isFinite(pt.latitude) &&
                  isFinite(pt.longitude)
              );
              if (validCoords.length < 2) return null;
              return (
                <Polyline
                  key={seg.id ? `road-${seg.id}` : `road-dbg-${idx}`}
                  coordinates={validCoords}
                  strokeColor="#00E676"
                  strokeWidth={3.5}
                  zIndex={50}
                />
              );
            })
            .filter(Boolean)}

        {/* Vehicle Position Marker */}
        {location && (
          <Marker
            coordinate={{
              latitude: location.latitude,
              longitude: location.longitude,
            }}
            anchor={{ x: 0.5, y: 0.5 }}
            flat={true}
            tracksViewChanges={true}
          >
            <VehicleMarker
              heading={
                mode === "follow_course" && isHeadingReliable ? 0 : heading
              }
              isDeadReckoning={isDeadReckoning}
              isHeadingReliable={isHeadingReliable}
            />
          </Marker>
        )}
      </MapView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
  },
  map: {
    ...StyleSheet.absoluteFill,
  },
  destinationPin: {
    alignItems: "center",
    justifyContent: "center",
  },
  referenceMarker: {
    alignItems: "center",
    justifyContent: "center",
  },
  referenceDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#00E5FF",
    borderWidth: 2,
    borderColor: "#fff",
  },
  referenceLabel: {
    color: "#00E5FF",
    fontSize: 8,
    fontWeight: "bold",
    marginTop: 2,
  },
});
