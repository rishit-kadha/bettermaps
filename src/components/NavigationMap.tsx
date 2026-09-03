import React, { useEffect, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import MapView, {
  Marker,
  Polyline,
  PROVIDER_DEFAULT,
  PROVIDER_GOOGLE,
} from "react-native-maps";
import { NavigationMode, NavigationTelemetry } from "../types/location";
import { VehiclePuck } from "./VehiclePuck";

interface NavigationMapProps {
  telemetry: NavigationTelemetry;
  onUserPan: () => void;
}

export const NavigationMap: React.FC<NavigationMapProps> = ({
  telemetry,
  onUserPan,
}) => {
  const mapRef = useRef<MapView | null>(null);
  const {
    currentLocation,
    smoothedHeading,
    mode,
    isDeadReckoning,
    historyTrail,
  } = telemetry;

  // Initial fallback region (Connaught Place, New Delhi)
  const defaultRegion = {
    latitude: 28.6315,
    longitude: 77.2167,
    latitudeDelta: 0.008,
    longitudeDelta: 0.008,
  };

  // Smooth camera tracking
  useEffect(() => {
    if (!currentLocation || !mapRef.current) return;
    if (mode === "free") return; // Do not interrupt user free navigation

    const cameraConfig = {
      center: {
        latitude: currentLocation.latitude,
        longitude: currentLocation.longitude,
      },
      zoom: 18,
      heading: mode === 'follow_course' && telemetry.isHeadingReliable ? smoothedHeading : 0,
      pitch: mode === 'follow_course' ? 45 : 0, // 3D driving perspective in course-up
      altitude: 200,
    };

    mapRef.current.animateCamera(cameraConfig, { duration: 400 });
  }, [
    currentLocation?.latitude,
    currentLocation?.longitude,
    smoothedHeading,
    telemetry.isHeadingReliable,
    mode,
  ]);

  // Use Google Maps provider on Android/iOS where available
  const provider =
    Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT;

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={provider}
        style={styles.map}
        initialRegion={defaultRegion}
        showsUserLocation={false} // We render our own decoupled VehiclePuck
        showsMyLocationButton={false}
        showsCompass={false}
        showsTraffic={false}
        showsBuildings={true}
        rotateEnabled={true}
        pitchEnabled={true}
        onPanDrag={onUserPan}
      >
        {/* Navigation History Breadcrumbs Trail */}
        {historyTrail.length > 1 && (
          <Polyline
            coordinates={historyTrail}
            strokeColor={
              isDeadReckoning
                ? "rgba(255, 152, 0, 0.6)"
                : "rgba(26, 115, 232, 0.5)"
            }
            strokeWidth={4}
            lineCap="round"
            lineJoin="round"
          />
        )}

        {/* Vehicle Navigation Puck with Real-time Heading */}
        {currentLocation && (
          <Marker
            coordinate={{
              latitude: currentLocation.latitude,
              longitude: currentLocation.longitude,
            }}
            anchor={{ x: 0.5, y: 0.5 }}
            flat={true} // Lays flat on map surface for 3D perspective
            tracksViewChanges={true}
          >
            <VehiclePuck
              heading={mode === 'follow_course' && telemetry.isHeadingReliable ? 0 : smoothedHeading}
              isDeadReckoning={isDeadReckoning}
              isHeadingReliable={telemetry.isHeadingReliable}
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
});
