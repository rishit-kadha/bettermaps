import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { NavigationMode, NavigationTelemetry } from '../types/location';

interface NavigationHUDProps {
  telemetry: NavigationTelemetry;
  diagnosticsOpen: boolean;
  onToggleDiagnostics: () => void;
  onRecenter: () => void;
  onToggleCompass: () => void;
  onRequestPermission: () => void;
  onSwitchProvider: () => void;
}

/**
 * Clean, modern navigation overlay.
 * Follows contemporary navigation UI conventions without copying proprietary assets.
 * Maximizes map viewport while providing immediate access to status, recenter,
 * compass, and live telemetry.
 */
export const NavigationHUD: React.FC<NavigationHUDProps> = ({
  telemetry,
  diagnosticsOpen,
  onToggleDiagnostics,
  onRecenter,
  onToggleCompass,
  onRequestPermission,
  onSwitchProvider,
}) => {
  const {
    currentLocation,
    speedKmh,
    smoothedHeading,
    isHeadingReliable,
    updateFrequencyHz,
    mode,
    providerStatus,
    providerType,
    isDeadReckoning,
  } = telemetry;

  const isFreeMode = mode === 'free';

  const getStatusBadge = () => {
    switch (providerStatus) {
      case 'permission_denied':
        return { text: 'NO PERMISSION', dotColor: '#EA4335', bg: '#FFFFFF' };
      case 'gnss_unavailable':
        return { text: 'GPS DISABLED', dotColor: '#E37400', bg: '#FFFFFF' };
      case 'initializing':
        return { text: 'ACQUIRING GNSS...', dotColor: '#FBBC04', bg: '#FFFFFF' };
      case 'error':
        return { text: 'GNSS ERROR', dotColor: '#EA4335', bg: '#FFFFFF' };
      default:
        if (providerType === 'mock') {
          return { text: 'SIMULATOR', dotColor: '#9334E6', bg: '#FFFFFF' };
        }
        return { text: 'GNSS 3D FIX', dotColor: '#137333', bg: '#FFFFFF' };
    }
  };

  const getCardinal = (deg: number): string => {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(deg / 45) % 8;
    return directions[index];
  };

  const badge = getStatusBadge();
  const accuracyText =
    currentLocation?.accuracy !== null && currentLocation?.accuracy !== undefined
      ? `±${currentLocation.accuracy.toFixed(1)}m`
      : '--';

  return (
    <View pointerEvents="box-none" style={styles.container}>
      {/* Top Floating Controls */}
      <View pointerEvents="box-none" style={styles.topRow}>
        {/* Status Indicator Pill */}
        <View style={styles.statusPill}>
          <View style={[styles.statusDot, { backgroundColor: badge.dotColor }]} />
          <Text style={styles.statusLabel}>{badge.text}</Text>
          {updateFrequencyHz > 0 && (
            <Text style={styles.hzTag}>{updateFrequencyHz.toFixed(1)}Hz</Text>
          )}
        </View>

        {/* Action Pills (Diagnostics & Mode Switcher) */}
        <View style={styles.topActions}>
          <TouchableOpacity
            style={[styles.actionPill, diagnosticsOpen && styles.actionPillActive]}
            onPress={onToggleDiagnostics}
            activeOpacity={0.8}
          >
            <Text style={[styles.actionPillText, diagnosticsOpen && styles.actionPillTextActive]}>
              {diagnosticsOpen ? 'Close Stats' : 'Diagnostics'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.actionPill}
            onPress={onSwitchProvider}
            activeOpacity={0.8}
          >
            <Text style={styles.actionPillText}>
              {providerType === 'gnss' ? 'Mode: GNSS' : 'Mode: Sim'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Permission Warning Banner (if permission denied) */}
      {providerStatus === 'permission_denied' && (
        <View style={styles.warningBanner}>
          <View style={styles.warningContent}>
            <Text style={styles.warningTitle}>Location Permission Required</Text>
            <Text style={styles.warningSubtitle}>
              BetterMaps needs location access to navigate and track vehicle position.
            </Text>
          </View>
          <TouchableOpacity
            style={styles.grantButton}
            onPress={onRequestPermission}
            activeOpacity={0.8}
          >
            <Text style={styles.grantButtonText}>Grant</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* GPS Disabled Warning Banner */}
      {providerStatus === 'gnss_unavailable' && (
        <View style={styles.warningBanner}>
          <View style={styles.warningContent}>
            <Text style={styles.warningTitle}>Location Services Disabled</Text>
            <Text style={styles.warningSubtitle}>
              Please enable GPS / Location in your Android device settings.
            </Text>
          </View>
        </View>
      )}

      {/* Right Floating Quick Controls (Compass & Recenter) */}
      <View pointerEvents="box-none" style={styles.floatingRightGroup}>
        {/* Compass Button */}
        <TouchableOpacity
          style={styles.circleFab}
          onPress={onToggleCompass}
          activeOpacity={0.8}
        >
          <View
            style={[
              styles.compassNeedleContainer,
              {
                transform: [
                  { rotate: `${mode === 'follow_course' ? 0 : 360 - smoothedHeading}deg` },
                ],
              },
            ]}
          >
            <View style={styles.compassNorth} />
            <View style={styles.compassSouth} />
          </View>
        </TouchableOpacity>

        {/* Recenter Button */}
        <TouchableOpacity
          style={[
            styles.circleFab,
            isFreeMode ? styles.recenterActiveFab : styles.recenterLockedFab,
          ]}
          onPress={onRecenter}
          activeOpacity={0.8}
        >
          {isFreeMode ? (
            <View style={styles.recenterInner}>
              <View style={styles.recenterIconFreeOuter}>
                <View style={styles.recenterIconFreeInner} />
              </View>
              <Text style={styles.recenterText}>Recenter</Text>
            </View>
          ) : (
            <View style={styles.recenterIconLocked}>
              <View style={styles.crosshairH} />
              <View style={styles.crosshairV} />
              <View style={styles.crosshairCenterDot} />
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* Bottom Telemetry Dock */}
      <View style={styles.bottomDock}>
        <View style={styles.telemetryCard}>
          {/* Speed Indicator */}
          <View style={styles.statCol}>
            <View style={styles.speedRow}>
              <Text style={styles.speedNum}>{speedKmh}</Text>
              <Text style={styles.speedUnit}>km/h</Text>
            </View>
            <Text style={styles.statLabel}>VEHICLE SPEED</Text>
          </View>

          <View style={styles.vertDivider} />

          {/* Bearing & Cardinal Direction */}
          <View style={styles.statCol}>
            <View style={styles.headingRow}>
              <Text style={styles.headingNum}>{smoothedHeading}°</Text>
              <Text style={styles.cardinalTag}>{getCardinal(smoothedHeading)}</Text>
            </View>
            <Text style={styles.statLabel}>
              {isHeadingReliable ? 'COURSE HEADING' : 'BEARING'}
            </Text>
          </View>

          <View style={styles.vertDivider} />

          {/* GPS Accuracy */}
          <View style={styles.statCol}>
            <Text style={styles.accuracyNum}>{accuracyText}</Text>
            <Text style={styles.statLabel}>ACCURACY</Text>
          </View>
        </View>
      </View>
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
    justifyContent: 'space-between',
    padding: 16,
  },
  topRow: {
    marginTop: 36,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    borderWidth: 1,
    borderColor: '#ECEFF1',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#3C4043',
    letterSpacing: 0.4,
  },
  hzTag: {
    fontSize: 10,
    fontWeight: '700',
    color: '#137333',
    backgroundColor: '#E6F4EA',
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    borderRadius: 6,
    marginLeft: 6,
  },
  topActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionPill: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    borderWidth: 1,
    borderColor: '#ECEFF1',
  },
  actionPillActive: {
    backgroundColor: '#1A73E8',
    borderColor: '#185ABC',
  },
  actionPillText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#3C4043',
  },
  actionPillTextActive: {
    color: '#FFFFFF',
  },
  warningBanner: {
    position: 'absolute',
    top: 90,
    left: 16,
    right: 16,
    backgroundColor: '#FEF7E0',
    borderWidth: 1,
    borderColor: '#FEEFC3',
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  warningContent: {
    flex: 1,
    marginRight: 10,
  },
  warningTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#B06000',
  },
  warningSubtitle: {
    fontSize: 11,
    color: '#5F6368',
    marginTop: 2,
  },
  grantButton: {
    backgroundColor: '#1A73E8',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
  },
  grantButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  floatingRightGroup: {
    position: 'absolute',
    right: 16,
    bottom: 120,
    alignItems: 'flex-end',
    gap: 12,
  },
  circleFab: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    minWidth: 48,
    height: 48,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    borderWidth: 1,
    borderColor: '#ECEFF1',
  },
  recenterActiveFab: {
    backgroundColor: '#1A73E8',
    borderColor: '#185ABC',
    flexDirection: 'row',
    paddingHorizontal: 14,
  },
  recenterLockedFab: {
    backgroundColor: '#FFFFFF',
  },
  recenterInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  recenterText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  recenterIconFreeOuter: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recenterIconFreeInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  recenterIconLocked: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  crosshairH: {
    position: 'absolute',
    width: 16,
    height: 2,
    backgroundColor: '#1A73E8',
  },
  crosshairV: {
    position: 'absolute',
    width: 2,
    height: 16,
    backgroundColor: '#1A73E8',
  },
  crosshairCenterDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#1A73E8',
    backgroundColor: '#FFFFFF',
  },
  compassNeedleContainer: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compassNorth: {
    width: 0,
    height: 0,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderBottomWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#EA4335', // Red north
  },
  compassSouth: {
    width: 0,
    height: 0,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderTopWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#80868B', // Grey south
  },
  bottomDock: {
    marginBottom: 10,
  },
  telemetryCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    borderWidth: 1,
    borderColor: '#ECEFF1',
  },
  statCol: {
    flex: 1,
    alignItems: 'center',
  },
  vertDivider: {
    width: 1,
    height: 36,
    backgroundColor: '#ECEFF1',
  },
  speedRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  speedNum: {
    fontSize: 28,
    fontWeight: '800',
    color: '#202124',
  },
  speedUnit: {
    fontSize: 11,
    fontWeight: '700',
    color: '#5F6368',
    marginLeft: 3,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  headingNum: {
    fontSize: 22,
    fontWeight: '700',
    color: '#202124',
  },
  cardinalTag: {
    fontSize: 12,
    fontWeight: '800',
    color: '#1A73E8',
    marginLeft: 4,
  },
  accuracyNum: {
    fontSize: 18,
    fontWeight: '700',
    color: '#137333',
  },
  statLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: '#80868B',
    marginTop: 2,
    letterSpacing: 0.6,
  },
});
