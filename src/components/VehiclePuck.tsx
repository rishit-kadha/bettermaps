import React from 'react';
import { StyleSheet, View } from 'react-native';

interface VehiclePuckProps {
  heading: number; // degrees 0 - 360
  isDeadReckoning?: boolean;
}

/**
 * High-visibility vehicle navigation puck.
 * Features an orientation arrow that rotates with the vehicle bearing,
 * surrounded by a navigation pulse ring.
 *
 * When isDeadReckoning is true, shifts to an Amber/Orange indicator
 * alerting the user that inertial dead reckoning is active.
 */
export const VehiclePuck: React.FC<VehiclePuckProps> = ({
  heading,
  isDeadReckoning = false,
}) => {
  const primaryColor = isDeadReckoning ? '#FF9800' : '#1A73E8'; // Amber for DR, Google Blue for GNSS
  const pulseColor = isDeadReckoning ? 'rgba(255, 152, 0, 0.25)' : 'rgba(26, 115, 232, 0.25)';

  return (
    <View style={styles.container}>
      {/* Outer accuracy / pulse glow */}
      <View style={[styles.pulseRing, { borderColor: pulseColor, backgroundColor: pulseColor }]} />

      {/* Rotating navigation arrow container */}
      <View
        style={[
          styles.arrowContainer,
          {
            transform: [{ rotate: `${heading}deg` }],
          },
        ]}
      >
        {/* Directional Chevron */}
        <View style={[styles.arrowHead, { borderBottomColor: primaryColor }]} />
        {/* Center core */}
        <View style={[styles.coreCircle, { backgroundColor: primaryColor }]}>
          <View style={styles.innerDot} />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: 60,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 1.5,
  },
  arrowContainer: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowHead: {
    position: 'absolute',
    top: -4,
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderBottomWidth: 14,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  coreCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2.5,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
  },
  innerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
});
