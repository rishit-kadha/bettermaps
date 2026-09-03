import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { NavigationTelemetry } from '../types/location';

interface NavigationHUDProps {
  telemetry: NavigationTelemetry;
  onToggleOutage?: () => void;
  isOutageSimulated?: boolean;
}

export const NavigationHUD: React.FC<NavigationHUDProps> = ({
  telemetry,
  onToggleOutage,
  isOutageSimulated = false,
}) => {
  const {
    currentLocation,
    speedKmh,
    smoothedHeading,
    providerStatus,
    providerType,
    isDeadReckoning,
  } = telemetry;

  // Convert heading to cardinal direction (N, NE, E, SE, S, SW, W, NW)
  const getCardinal = (deg: number): string => {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(deg / 45) % 8;
    return directions[index];
  };

  const getStatusBadge = () => {
    if (providerStatus === 'permission_denied') {
      return { text: 'PERMISSION REQUIRED', color: '#EA4335', bg: '#FCE8E6' };
    }
    if (providerStatus === 'gnss_unavailable') {
      return { text: 'GNSS OUTAGE / TUNNEL', color: '#E37400', bg: '#FEF7E0' };
    }
    if (providerStatus === 'initializing') {
      return { text: 'ACQUIRING FIX...', color: '#1A73E8', bg: '#E8F0FE' };
    }
    if (isDeadReckoning) {
      return { text: 'DEAD RECKONING (IMU)', color: '#FF9800', bg: '#FFF3E0' };
    }
    if (providerType === 'mock') {
      return { text: 'SIMULATION ROUTE', color: '#9334E6', bg: '#F3E8FD' };
    }
    return { text: 'GNSS LOCK (PHASE 1)', color: '#137333', bg: '#CEEAD6' };
  };

  const badge = getStatusBadge();
  const accuracyText = currentLocation?.accuracy
    ? `±${currentLocation.accuracy.toFixed(1)} m`
    : '-- m';

  return (
    <View pointerEvents="box-none" style={styles.container}>
      {/* Top Status Bar */}
      <View style={styles.topContainer}>
        <View style={[styles.statusBadge, { backgroundColor: badge.bg }]}>
          <View style={[styles.statusDot, { backgroundColor: badge.color }]} />
          <Text style={[styles.statusText, { color: badge.color }]}>{badge.text}</Text>
        </View>

        {/* Quick tunnel / outage test button if available */}
        {onToggleOutage && providerType === 'mock' && (
          <TouchableOpacity
            onPress={onToggleOutage}
            activeOpacity={0.8}
            style={[
              styles.outageButton,
              isOutageSimulated && styles.outageButtonActive,
            ]}
          >
            <Text
              style={[
                styles.outageButtonText,
                isOutageSimulated && styles.outageButtonTextActive,
              ]}
            >
              {isOutageSimulated ? 'Exit Tunnel' : 'Simulate Tunnel (GPS Loss)'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Bottom Telemetry Card */}
      <View style={styles.bottomCard}>
        <View style={styles.row}>
          {/* Speedometer */}
          <View style={styles.statBox}>
            <View style={styles.speedRow}>
              <Text style={styles.speedValue}>{speedKmh}</Text>
              <Text style={styles.speedUnit}>km/h</Text>
            </View>
            <Text style={styles.statLabel}>SPEED</Text>
          </View>

          <View style={styles.divider} />

          {/* Heading / Compass */}
          <View style={styles.statBox}>
            <View style={styles.speedRow}>
              <Text style={styles.headingValue}>{smoothedHeading}°</Text>
              <Text style={styles.cardinalValue}>{getCardinal(smoothedHeading)}</Text>
            </View>
            <Text style={styles.statLabel}>HEADING</Text>
          </View>

          <View style={styles.divider} />

          {/* Accuracy */}
          <View style={styles.statBox}>
            <Text style={styles.accuracyValue}>{accuracyText}</Text>
            <Text style={styles.statLabel}>ACCURACY</Text>
          </View>
        </View>

        {/* Coordinates Footer */}
        {currentLocation && (
          <View style={styles.coordsFooter}>
            <Text style={styles.coordsText}>
              {currentLocation.latitude.toFixed(5)}°N, {currentLocation.longitude.toFixed(5)}°E
            </Text>
            <Text style={styles.engineText}>
              Provider: {telemetry.providerName}
            </Text>
          </View>
        )}
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
  topContainer: {
    marginTop: 36,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  outageButton: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DADCE0',
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  outageButtonActive: {
    backgroundColor: '#EA4335',
    borderColor: '#C5221F',
  },
  outageButtonText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#3C4043',
  },
  outageButtonTextActive: {
    color: '#FFFFFF',
  },
  bottomCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  statBox: {
    flex: 1,
    alignItems: 'center',
  },
  divider: {
    width: 1,
    height: 36,
    backgroundColor: '#E8EAED',
  },
  speedRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  speedValue: {
    fontSize: 26,
    fontWeight: '800',
    color: '#202124',
  },
  speedUnit: {
    fontSize: 11,
    fontWeight: '600',
    color: '#5F6368',
    marginLeft: 3,
  },
  headingValue: {
    fontSize: 22,
    fontWeight: '700',
    color: '#202124',
  },
  cardinalValue: {
    fontSize: 12,
    fontWeight: '700',
    color: '#1A73E8',
    marginLeft: 4,
  },
  accuracyValue: {
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
  coordsFooter: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#F1F3F4',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  coordsText: {
    fontSize: 10,
    color: '#5F6368',
    fontFamily: 'monospace',
  },
  engineText: {
    fontSize: 10,
    color: '#70757A',
    fontWeight: '500',
  },
});
