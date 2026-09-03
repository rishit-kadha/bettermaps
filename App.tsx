import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationControls } from './src/components/NavigationControls';
import { NavigationHUD } from './src/components/NavigationHUD';
import { NavigationMap } from './src/components/NavigationMap';
import { AvailableProviderId, providerRegistry } from './src/providers';
import { navigationManager } from './src/services/NavigationManager';
import { NavigationTelemetry } from './src/types/location';

export default function App() {
  const [telemetry, setTelemetry] = useState<NavigationTelemetry>(() =>
    navigationManager.getTelemetry()
  );
  const [activeProviderId, setActiveProviderId] = useState<AvailableProviderId>('gnss');
  const [isOutageSimulated, setIsOutageSimulated] = useState<boolean>(false);

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

  const handleSwitchProvider = async (id: AvailableProviderId) => {
    setActiveProviderId(id);
    setIsOutageSimulated(false);
    await navigationManager.switchProvider(id);
  };

  const handleToggleOutage = () => {
    const mockProvider = providerRegistry.getMockProvider();
    const isOutage = mockProvider.toggleOutageSimulation();
    setIsOutageSimulated(isOutage);
  };

  const handleToggleMode = () => {
    navigationManager.toggleNavigationMode();
  };

  const handleRecenter = () => {
    navigationManager.recenter();
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

        {/* 1. Map Layer (Google Maps + Custom Vehicle Puck) */}
        <NavigationMap telemetry={telemetry} onUserPan={handleUserPan} />

        {/* 2. Interactive Navigation Controls (Mode toggle, Provider switch, Recenter) */}
        <NavigationControls
          mode={telemetry.mode}
          onToggleMode={handleToggleMode}
          onRecenter={handleRecenter}
          activeProviderId={activeProviderId}
          onSwitchProvider={handleSwitchProvider}
        />

        {/* 3. Navigation HUD (Speedometer, Compass/Bearing, Accuracy, GPS Lock status) */}
        <NavigationHUD
          telemetry={telemetry}
          onToggleOutage={handleToggleOutage}
          isOutageSimulated={isOutageSimulated}
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
