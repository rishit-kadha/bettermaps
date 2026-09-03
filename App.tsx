import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DiagnosticsPanel } from './src/components/DiagnosticsPanel';
import { NavigationHUD } from './src/components/NavigationHUD';
import { NavigationMap } from './src/components/NavigationMap';
import { AvailableProviderId } from './src/providers';
import { navigationManager } from './src/services/NavigationManager';
import { NavigationTelemetry } from './src/types/location';

export default function App() {
  const [telemetry, setTelemetry] = useState<NavigationTelemetry>(() =>
    navigationManager.getTelemetry()
  );
  const [diagnosticsOpen, setDiagnosticsOpen] = useState<boolean>(false);

  useEffect(() => {
    // 1. Subscribe to navigation telemetry stream
    const unsubscribe = navigationManager.subscribeTelemetry((updatedTelemetry) => {
      setTelemetry(updatedTelemetry);
    });

    // 2. Start positioning engine
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
      telemetry.providerType === 'gnss' ? 'mock' : 'gnss';
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

        {/* 1. Map Layer: Google Maps + Dynamic Vehicle Puck + Breadcrumbs */}
        <NavigationMap telemetry={telemetry} onUserPan={handleUserPan} />

        {/* 2. Navigation HUD: Top status bar, floating compass, recenter FAB, bottom telemetry dock */}
        <NavigationHUD
          telemetry={telemetry}
          diagnosticsOpen={diagnosticsOpen}
          onToggleDiagnostics={handleToggleDiagnostics}
          onRecenter={handleRecenter}
          onToggleCompass={handleToggleCompass}
          onRequestPermission={handleRequestPermission}
          onSwitchProvider={handleSwitchProvider}
        />

        {/* 3. GNSS Diagnostics Panel: Real-time update frequency (Hz), coordinates, provider health */}
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
