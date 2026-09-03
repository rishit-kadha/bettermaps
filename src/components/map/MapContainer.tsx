import React, { useEffect, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_DEFAULT, PROVIDER_GOOGLE } from 'react-native-maps';
import { NavLocation } from '../../core/types/location';
import { NavigationMode } from '../../core/types/navigation';
import { VehicleMarker } from './VehicleMarker';

export interface MapContainerProps {
  location: NavLocation | null;
  heading: number;
  isHeadingReliable: boolean;
  mode: NavigationMode;
  isDeadReckoning?: boolean;
  historyTrail: { latitude: number; longitude: number }[];
  onUserPan: () => void;
}

/**
 * MapContainer
 *
 * Application-level Map Abstraction.
 * Isolates Google Maps-specific logic, camera interpolation, and rendering
 * behind a clean component interface.
 *
 * If the map provider is ever migrated or swapped (e.g. Mapbox, Tangram, or custom GL),
 * only this file changes — the rest of the application remains untouched.
 */
export const MapContainer: React.FC<MapContainerProps> = ({
  location,
  heading,
  isHeadingReliable,
  mode,
  isDeadReckoning = false,
  historyTrail,
  onUserPan,
}) => {
  const mapRef = useRef<MapView | null>(null);

  // Default initial viewport (Connaught Place, New Delhi)
  const defaultRegion = {
    latitude: 28.6315,
    longitude: 77.2167,
    latitudeDelta: 0.008,
    longitudeDelta: 0.008,
  };

  // Smooth camera tracking
  useEffect(() => {
    if (!location || !mapRef.current) return;
    if (mode === 'free') return; // Do not interrupt user manual panning

    const cameraConfig = {
      center: {
        latitude: location.latitude,
        longitude: location.longitude,
      },
      zoom: 18,
      heading: mode === 'follow_course' && isHeadingReliable ? heading : 0,
      pitch: mode === 'follow_course' ? 45 : 0, // 3D driving tilt in course-up mode
      altitude: 200,
    };

    mapRef.current.animateCamera(cameraConfig, { duration: 400 });
  }, [location?.latitude, location?.longitude, heading, isHeadingReliable, mode]);

  const mapProvider = Platform.OS === 'android' ? PROVIDER_GOOGLE : PROVIDER_DEFAULT;

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={mapProvider}
        style={styles.map}
        initialRegion={defaultRegion}
        showsUserLocation={false} // Uses our own normalized VehicleMarker
        showsMyLocationButton={false}
        showsCompass={false}
        showsTraffic={false}
        showsBuildings={true}
        rotateEnabled={true}
        pitchEnabled={true}
        onPanDrag={onUserPan}
      >
        {/* Trajectory Breadcrumb Polyline */}
        {historyTrail.length > 1 && (
          <Polyline
            coordinates={historyTrail}
            strokeColor={isDeadReckoning ? 'rgba(255, 152, 0, 0.6)' : 'rgba(26, 115, 232, 0.5)'}
            strokeWidth={4}
            lineCap="round"
            lineJoin="round"
          />
        )}

        {/* Vehicle Marker */}
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
              heading={mode === 'follow_course' && isHeadingReliable ? 0 : heading}
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
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  map: {
    width: '100%',
    height: '100%',
  },
});
