import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { NavigationTelemetry } from '../types/location';

interface DiagnosticsPanelProps {
  telemetry: NavigationTelemetry;
  visible: boolean;
  onClose: () => void;
}

/**
 * Diagnostics Panel
 *
 * Floating debug panel displaying real-time positioning metrics:
 * - Latitude / Longitude
 * - Heading & Heading Reliability
 * - Speed (km/h & m/s)
 * - Horizontal Accuracy (meters)
 * - Location Update Frequency (~Hz)
 * - Active Provider (GNSS vs Future IDR)
 *
 * Essential for validating GNSS performance in Phase 1 and benchmarking
 * against the IDR engine in later phases.
 */
export const DiagnosticsPanel: React.FC<DiagnosticsPanelProps> = ({
  telemetry,
  visible,
  onClose,
}) => {
  if (!visible) return null;

  const {
    currentLocation,
    speedKmh,
    smoothedHeading,
    isHeadingReliable,
    updateFrequencyHz,
    providerName,
    providerType,
    providerStatus,
    isDeadReckoning,
  } = telemetry;

  const latText = currentLocation ? `${currentLocation.latitude.toFixed(6)}°` : '--';
  const lngText = currentLocation ? `${currentLocation.longitude.toFixed(6)}°` : '--';
  const altText =
    currentLocation?.altitude !== null && currentLocation?.altitude !== undefined
      ? `${currentLocation.altitude.toFixed(1)} m`
      : '--';
  const accText =
    currentLocation?.accuracy !== null && currentLocation?.accuracy !== undefined
      ? `±${currentLocation.accuracy.toFixed(1)} m`
      : '--';
  const speedMsText =
    currentLocation?.speed !== null && currentLocation?.speed !== undefined
      ? `${currentLocation.speed.toFixed(1)} m/s`
      : '--';

  const formatTime = (epochMs?: number) => {
    if (!epochMs) return '--';
    const d = new Date(epochMs);
    return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={styles.indicator} />
          <Text style={styles.title}>GNSS DIAGNOSTICS</Text>
        </View>
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.closeText}>✕</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.grid}>
        {/* Row 1: Provider & Hz */}
        <View style={styles.row}>
          <View style={styles.cell}>
            <Text style={styles.label}>PROVIDER</Text>
            <Text style={styles.valueHighlight}>
              {providerType === 'gnss' ? 'GNSS' : providerType.toUpperCase()}
            </Text>
            <Text style={styles.subText}>{providerName}</Text>
          </View>

          <View style={styles.cell}>
            <Text style={styles.label}>UPDATE FREQ</Text>
            <Text style={[styles.valueHighlight, { color: updateFrequencyHz > 0 ? '#137333' : '#EA4335' }]}>
              ~{updateFrequencyHz.toFixed(1)} Hz
            </Text>
            <Text style={styles.subText}>Target: ~10 Hz (IDR)</Text>
          </View>
        </View>

        {/* Row 2: Speed & Heading */}
        <View style={styles.row}>
          <View style={styles.cell}>
            <Text style={styles.label}>SPEED</Text>
            <Text style={styles.value}>
              {speedKmh} <Text style={styles.unit}>km/h</Text>
            </Text>
            <Text style={styles.subText}>({speedMsText})</Text>
          </View>

          <View style={styles.cell}>
            <Text style={styles.label}>HEADING</Text>
            <Text style={styles.value}>
              {smoothedHeading}°
            </Text>
            <Text style={[styles.subText, { color: isHeadingReliable ? '#137333' : '#E37400' }]}>
              {isHeadingReliable ? 'Reliable (Course)' : 'Stationary/Unreliable'}
            </Text>
          </View>
        </View>

        {/* Row 3: Accuracy & Altitude */}
        <View style={styles.row}>
          <View style={styles.cell}>
            <Text style={styles.label}>HORIZONTAL ACCURACY</Text>
            <Text style={[styles.value, { color: '#1A73E8' }]}>{accText}</Text>
          </View>

          <View style={styles.cell}>
            <Text style={styles.label}>ALTITUDE</Text>
            <Text style={styles.value}>{altText}</Text>
          </View>
        </View>

        {/* Row 4: Coordinates */}
        <View style={styles.coordsBox}>
          <View style={styles.coordCol}>
            <Text style={styles.label}>LATITUDE</Text>
            <Text style={styles.coordValue}>{latText}</Text>
          </View>
          <View style={styles.coordCol}>
            <Text style={styles.label}>LONGITUDE</Text>
            <Text style={styles.coordValue}>{lngText}</Text>
          </View>
        </View>

        {/* Status / Timestamp */}
        <View style={styles.footerRow}>
          <Text style={styles.footerText}>
            Status: <Text style={styles.boldText}>{providerStatus.toUpperCase()}</Text>
          </Text>
          <Text style={styles.footerText}>
            Fix: {formatTime(currentLocation?.timestamp)}
          </Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 90,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.96)',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#DADCE0',
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F3F4',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  indicator: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#1A73E8',
    marginRight: 6,
  },
  title: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: '#3C4043',
  },
  closeText: {
    fontSize: 14,
    color: '#80868B',
    fontWeight: '700',
    paddingHorizontal: 4,
  },
  grid: {
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  cell: {
    flex: 1,
    backgroundColor: '#F8F9FA',
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: '#ECEFF1',
  },
  label: {
    fontSize: 9,
    fontWeight: '700',
    color: '#70757A',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  valueHighlight: {
    fontSize: 16,
    fontWeight: '800',
    color: '#202124',
  },
  value: {
    fontSize: 15,
    fontWeight: '700',
    color: '#202124',
  },
  unit: {
    fontSize: 10,
    fontWeight: '600',
    color: '#5F6368',
  },
  subText: {
    fontSize: 9,
    color: '#5F6368',
    marginTop: 2,
  },
  coordsBox: {
    flexDirection: 'row',
    backgroundColor: '#F8F9FA',
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: '#ECEFF1',
  },
  coordCol: {
    flex: 1,
  },
  coordValue: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
    color: '#202124',
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 4,
  },
  footerText: {
    fontSize: 9,
    color: '#70757A',
  },
  boldText: {
    fontWeight: '700',
    color: '#202124',
  },
});
