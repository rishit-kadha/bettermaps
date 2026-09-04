import React from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NavigationTelemetry } from "../../core/types/navigation";
import { BottomHUD } from "../navigation/BottomHUD";
import { MapControls } from "../navigation/MapControls";
import { SystemWarningBanner } from "../navigation/SystemWarningBanner";

interface NavigationHUDProps {
  telemetry: NavigationTelemetry;
  diagnosticsOpen?: boolean;
  hideBottomDock?: boolean;
  hideTopRow?: boolean;
  onToggleDiagnostics?: () => void;
  onRecenter: () => void;
  onToggleCompass: () => void;
  onTogglePerspective: () => void;
  onRequestPermission: () => void;
  onSwitchProvider?: () => void;
  onOpenSensors?: () => void;
  isSensorRecording?: boolean;
}

/**
 * NavigationHUD
 *
 * Backwards-compatible coordinator composing independent MapControls and BottomHUD.
 * Each child component has its own absolute positioning context.
 */
export const NavigationHUD: React.FC<NavigationHUDProps> = ({
  telemetry,
  hideBottomDock = false,
  onRecenter,
  onToggleCompass,
  onTogglePerspective,
  onRequestPermission,
  onOpenSensors,
  isSensorRecording = false,
}) => {
  const insets = useSafeAreaInsets();
  const isOutageActive =
    telemetry.gnssStreamGateState === "GNSS_STREAM_DISABLED";

  const controlsBottomOffset = hideBottomDock
    ? Math.max(insets.bottom, 12) + 20
    : Math.max(insets.bottom, 12) + 84;

  return (
    <View pointerEvents="box-none" style={styles.container}>
      {/* 1. System Warning Banners */}
      <SystemWarningBanner
        providerStatus={telemetry.providerStatus}
        isOutageActive={isOutageActive}
        onRequestPermission={onRequestPermission}
      />

      {/* 2. Floating Action Buttons (Right side) */}
      <MapControls
        mode={telemetry.mode}
        cameraPerspective={telemetry.cameraPerspective}
        smoothedHeading={telemetry.smoothedHeading}
        isSensorRecording={isSensorRecording}
        bottomOffset={controlsBottomOffset}
        onOpenSensors={onOpenSensors}
        onTogglePerspective={onTogglePerspective}
        onToggleCompass={onToggleCompass}
        onRecenter={onRecenter}
      />

      {/* 3. Bottom Telemetry Dock (Strictly anchored to bottom) */}
      {!hideBottomDock && <BottomHUD telemetry={telemetry} />}
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
});
