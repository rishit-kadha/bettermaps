import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { AvailableProviderId } from '../providers';
import { NavigationMode } from '../types/location';

interface NavigationControlsProps {
  mode: NavigationMode;
  onToggleMode: () => void;
  onRecenter: () => void;
  activeProviderId: AvailableProviderId;
  onSwitchProvider: (id: AvailableProviderId) => void;
}

export const NavigationControls: React.FC<NavigationControlsProps> = ({
  mode,
  onToggleMode,
  onRecenter,
  activeProviderId,
  onSwitchProvider,
}) => {
  const getModeIconText = () => {
    switch (mode) {
      case 'follow_course':
        return '▲ Course';
      case 'follow_north':
        return '🧭 North';
      case 'free':
        return '🔍 Free';
    }
  };

  return (
    <View pointerEvents="box-none" style={styles.container}>
      {/* Provider Switcher Toggle */}
      <View style={styles.providerToggleGroup}>
        <TouchableOpacity
          style={[
            styles.providerButton,
            activeProviderId === 'gnss' && styles.providerButtonActive,
          ]}
          onPress={() => onSwitchProvider('gnss')}
          activeOpacity={0.8}
        >
          <Text
            style={[
              styles.providerButtonText,
              activeProviderId === 'gnss' && styles.providerButtonTextActive,
            ]}
          >
            🛰️ Live GNSS
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.providerButton,
            activeProviderId === 'mock' && styles.providerButtonActive,
          ]}
          onPress={() => onSwitchProvider('mock')}
          activeOpacity={0.8}
        >
          <Text
            style={[
              styles.providerButtonText,
              activeProviderId === 'mock' && styles.providerButtonTextActive,
            ]}
          >
            🚗 Simulator
          </Text>
        </TouchableOpacity>
      </View>

      {/* Floating Action Buttons */}
      <View style={styles.fabColumn}>
        {/* Tracking Mode Switcher */}
        <TouchableOpacity
          style={styles.fab}
          onPress={onToggleMode}
          activeOpacity={0.8}
        >
          <Text style={styles.fabText}>{getModeIconText()}</Text>
        </TouchableOpacity>

        {/* Recenter Button */}
        {mode === 'free' && (
          <TouchableOpacity
            style={[styles.fab, styles.recenterFab]}
            onPress={onRecenter}
            activeOpacity={0.8}
          >
            <Text style={styles.recenterFabText}>🎯 Recenter</Text>
          </TouchableOpacity>
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
    paddingHorizontal: 16,
  },
  providerToggleGroup: {
    position: 'absolute',
    top: 90,
    alignSelf: 'center',
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 3,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
  },
  providerButton: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 17,
  },
  providerButtonActive: {
    backgroundColor: '#1A73E8',
  },
  providerButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#5F6368',
  },
  providerButtonTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  fabColumn: {
    position: 'absolute',
    right: 16,
    bottom: 150,
    alignItems: 'flex-end',
    gap: 12,
  },
  fab: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 24,
    elevation: 5,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    borderWidth: 1,
    borderColor: '#DADCE0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#1A73E8',
  },
  recenterFab: {
    backgroundColor: '#1A73E8',
    borderColor: '#185ABC',
  },
  recenterFabText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
