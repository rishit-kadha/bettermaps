import { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'BetterMaps',
  slug: 'bettermaps',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  ios: {
    supportsTablet: true,
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'BetterMaps requires your location to display your real-time navigation position on the map.',
    },
  },
  android: {
    package: 'com.sih.bettermaps',
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    permissions: [
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
    ],
    config: {
      googleMaps: {
        // Reads safely from environment variable without committing secret keys
        apiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || '',
      },
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          'Allow BetterMaps to access your location to navigate and track positioning.',
      },
    ],
  ],
  web: {
    favicon: './assets/favicon.png',
  },
});
