import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AvailableProviderId } from './src/adapters/location';
import { MapContainer } from './src/components/map/MapContainer';
import { DiagnosticsPanel } from './src/components/ui/DiagnosticsPanel';
import { NavigationHUD } from './src/components/ui/NavigationHUD';
import { navigationManager } from './src/core/state/NavigationManager';
import { NavigationTelemetry } from './src/core/types/navigation';

export default function App() {
  const [telemetry, setTelemetry] = useState<NavigationTelemetry>(() =>
    navigationManager.getTelemetry()
  );
  const [diagnosticsOpen, setDiagnosticsOpen] = useState<boolean>(false);

  useEffect(() => {
    // 1. Subscribe to shared navigation state stream
    const unsubscribe = navigationManager.subscribeTelemetry((updatedTelemetry) => {
      setTelemetry(updatedTelemetry);
    });

    // 2. Start platform location engine
    navigationManager.start().catch((err) => {
      console.error('Failed to start navigation engine:', err);
    });

    return () => {
      unsubscribe();
      navigationManager.stop().catch(() => {});
    };
  }, []);

  const handleSwitchProvider = async () => {
    const nextId: AvailableProviderId =
      telemetry.providerType === 'gnss' ? 'mock' : 'native_gnss';
    await navigationManager.switchProvider(nextId);
  };

  const handleRecenter = () => {
    navigationManager.recenter();
  };

  const handleToggleCompass = () => {
    navigationManager.toggleNavigationMode();
  };

  const handleToggleDiagnostics = () => {
    setDiagnosticsOpen((prev) => !prev);
  };

  const handleRequestPermission = async () => {
    await navigationManager.requestPermissions();
  };

  const handleUserPan = () => {
    if (telemetry.mode !== 'free') {
      navigationManager.setNavigationMode('free');
    }
  };

  return (
    <SafeAreaProvider>
      <View style={styles.container}>
        <StatusBar style="dark" />

        {/* 1. Map Layer: Isolated MapContainer abstraction (Google Maps, custom puck, breadcrumbs) */}
        <MapContainer
          location={telemetry.currentLocation}
          heading={telemetry.smoothedHeading}
          isHeadingReliable={telemetry.isHeadingReliable}
          mode={telemetry.mode}
          isDeadReckoning={telemetry.isDeadReckoning}
          historyTrail={telemetry.historyTrail}
          onUserPan={handleUserPan}
        />

        {/* 2. Navigation HUD: Top status pill, floating compass, recenter FAB, bottom telemetry dock */}
        <NavigationHUD
          telemetry={telemetry}
          diagnosticsOpen={diagnosticsOpen}
          onToggleDiagnostics={handleToggleDiagnostics}
          onRecenter={handleRecenter}
          onToggleCompass={handleToggleCompass}
          onRequestPermission={handleRequestPermission}
          onSwitchProvider={handleSwitchProvider}
        />

        {/* 3. GNSS Diagnostics Panel: Live update frequency (approx Hz), coordinates, provider health */}
        <DiagnosticsPanel
          telemetry={telemetry}
          visible={diagnosticsOpen}
          onClose={() => setDiagnosticsOpen(false)}
        />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8F9FA',
  },
});
