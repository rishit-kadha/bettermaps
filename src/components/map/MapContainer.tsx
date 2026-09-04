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
}

/**
 * MapContainer
 *
 * Application-level Map Abstraction.
 * Isolates Google Maps-specific logic, camera interpolation, active route polylines,
 * destination rendering, and dead-reckoning trajectory replay comparison behind a clean component interface.
 */
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
}) => {
  const mapRef = useRef<MapView | null>(null);
  const prevStatusRef = useRef<NavigationStatus>(navigationStatus);

  // Default initial viewport (Connaught Place, New Delhi)
  const defaultRegion = {
    latitude: 28.6315,
    longitude: 77.2167,
    latitudeDelta: 0.008,
    longitudeDelta: 0.008,
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
  useEffect(() => {
    if (!location || !mapRef.current) return;
    if (navigationStatus === "route_preview") return; // Keep route overview framed
    if (mode === "free") return; // Do not interrupt user manual panning

    const isNavigating = navigationStatus === "navigating";
    const is3D = cameraPerspective === "3D";

    const cameraConfig = {
      center: {
        latitude: location.latitude,
        longitude: location.longitude,
      },
      zoom: isNavigating ? (is3D ? 19 : 18.5) : 18,
      heading: mode === "follow_course" && isHeadingReliable ? heading : 0,
      pitch: is3D && mode === "follow_course" ? (isNavigating ? 50 : 45) : 0, // 0 for 2D top-down mode
      altitude: is3D ? (isNavigating ? 140 : 200) : 300,
    };

    mapRef.current.animateCamera(cameraConfig, { duration: 400 });
  }, [
    location?.latitude,
    location?.longitude,
    heading,
    isHeadingReliable,
    mode,
    cameraPerspective,
    navigationStatus,
  ]);

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
        showsUserLocation={false} // Uses our normalized VehicleMarker
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
            {/* Outer polyline casing (dark border for contrast) */}
            <Polyline
              coordinates={activeRoute.geometry.points}
              strokeColor={theme.routePolylineBorder}
              strokeWidth={8}
              lineCap="round"
              lineJoin="round"
            />
            {/* Inner primary route polyline (vibrant navigation accent) */}
            <Polyline
              coordinates={activeRoute.geometry.points}
              strokeColor={theme.routePolylineCore}
              strokeWidth={6}
              lineCap="round"
              lineJoin="round"
            />
          </>
        )}

        {/* Trajectory Breadcrumb Polyline (if not actively navigating) */}
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

        {/* Destination Marker */}
        {activeRoute && (
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

        {/* Replay Reference Ground-Truth Trail (Dashed Cyan) */}
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

        {/* Replay Estimated Dead-Reckoning Trail (Solid Amber) */}
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

        {/* Replay Reference Position Marker (Cyan ring + REF tag) */}
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

        {/* Vehicle Position Marker */}
        {location && (
          <Marker
            coordinate={{
              latitude: location.latitude,
              longitude: location.longitude,
            }}
            anchor={{ x: 0.5, y: 0.5 }}
            flat={true} // Lays flat on map plane for 3D navigation perspective
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
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  map: {
    width: "100%",
    height: "100%",
  },
  destinationPin: {
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  referenceMarker: {
    alignItems: "center",
    justifyContent: "center",
  },
  referenceDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#00E5FF",
    borderWidth: 2,
    borderColor: "#FFFFFF",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
  referenceLabel: {
    fontSize: 8,
    fontWeight: "800",
    color: "#FFFFFF",
    backgroundColor: "rgba(0, 180, 216, 0.9)",
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    marginTop: 2,
    overflow: "hidden",
  },
});
