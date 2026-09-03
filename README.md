# BetterMaps 🧭
### AI-ML based Intelligent Dead Reckoning System for Seamless Navigation
*Smart India Hackathon (SIH) Solution*

BetterMaps is a smartphone navigation application engineered to provide seamless, accurate positioning when GNSS/GPS is unavailable (in tunnels, underground parking structures, urban canyons, or under dense tree canopies).

---

## Phase 1 Deliverables (Current Phase)

Phase 1 establishes the mobile navigation shell and decoupled architecture:
- **Google Maps Integration**: Native Google Maps rendering via `react-native-maps` (`PROVIDER_GOOGLE`).
- **Decoupled Architecture**: Strict `ILocationProvider` interface decoupling the UI from hardware positioning sources.
- **Real-Time GNSS Provider**: `GnssLocationProvider` streaming live phone GPS coordinates, bearing, and speed via Android's `FusedLocationProviderClient`.
- **Route Simulator**: `MockLocationProvider` with simulated vehicle driving and a "Simulate Tunnel (GPS Loss)" toggle for instant offline testing and demonstration.
- **Smooth Navigation Camera**: Automatic camera following with Course-Up (3D perspective), North-Up (2D), and Free-Look modes with auto-recentering.
- **Navigation Telemetry HUD**: Speedometer (km/h), compass bearing with cardinal notation, GPS accuracy, and provider health badge.

---

## Project Structure

```
bettermaps/
├── src/
│   ├── types/
│   │   └── location.ts            # ILocationProvider, NavLocation, ProviderStatus
│   ├── providers/
│   │   ├── GnssLocationProvider.ts # Device GNSS (FusedLocationProviderClient)
│   │   ├── MockLocationProvider.ts # Route replay & GPS outage simulation
│   │   └── index.ts               # Provider registry and factory
│   ├── services/
│   │   └── NavigationManager.ts   # Navigation state, bearing filtering, camera tracking
│   └── components/
│       ├── NavigationMap.tsx      # Google Maps + camera follow + breadcrumb trail
│       ├── VehiclePuck.tsx        # Navigation vehicle puck with heading chevron
│       ├── NavigationHUD.tsx      # Speedometer, bearing, accuracy & status badge
│       └── NavigationControls.tsx # Mode switcher, recenter, provider selector
├── App.tsx                        # Main application entry
├── app.json                       # Android permissions, package name, Google Maps config
├── ARCHITECTURE.md                # In-depth system architecture & IDR roadmap
└── README.md
```

---

## Quick Start (Testing on Android Phone)

### 1. Prerequisites
- Node.js (v18+)
- Install the **Expo Go** app on your Android smartphone from the [Google Play Store](https://play.google.com/store/apps/details?id=host.exp.exponent).

### 2. Start the Development Server
From the project directory:

```bash
npm start
```

### 3. Open on Your Android Phone
1. Ensure your phone and computer are connected to the same Wi-Fi network (or use `npx expo start --tunnel` if on separate networks).
2. Open the **Expo Go** app on your Android phone.
3. Tap **Scan QR code** and scan the QR code displayed in your terminal.
4. The app will bundle and run live on your phone!

---

## Google Maps Android API Key Configuration

By default in Expo Go, maps render with development credentials. For production builds or standalone APKs:

1. Obtain an Android Maps API key from the [Google Cloud Console](https://console.cloud.google.com/google/maps-apis).
2. Enable the **Maps SDK for Android**.
3. In `app.json`, replace `"YOUR_GOOGLE_MAPS_ANDROID_API_KEY"` under `expo.android.config.googleMaps.apiKey` with your actual key:

```json
"android": {
  "config": {
    "googleMaps": {
      "apiKey": "AIzaSy..."
    }
  }
}
```

---

## Testing Features in the App

1. **Live GPS Tracking**: By default, the app starts with `🛰️ Live GNSS`. On your phone, accept the location permission when prompted. Walk or drive to observe the real-time speed, heading chevron, and smooth camera tracking.
2. **Driving Simulator**: Tap `🚗 Simulator` in the top bar to switch to the simulated vehicle route in New Delhi. The camera will immediately lock onto the simulated vehicle traveling through turns, accelerating, and decelerating.
3. **Simulate GPS Loss (Tunnel)**: While in simulator mode, tap **Simulate Tunnel (GPS Loss)** in the top bar. The provider status changes to `GNSS OUTAGE / TUNNEL`, demonstrating how the application handles GNSS denial before dead reckoning recovery.
4. **Camera Controls**:
   - Tap **▲ Course** to cycle between **Course-Up** (3D driving perspective), **North-Up** (2D top-down), and **Free** mode.
   - Drag anywhere on the map to switch into Free mode.
   - Tap **🎯 Recenter** to re-engage navigation lock.

---

## Next Steps: Phase 2 & 3 Roadmap

- **Phase 2**: Access smartphone `SensorManager` (Accelerometer, Gyroscope, Magnetometer @ 50-100Hz), implement attitude estimation (Madgwick/Mahony AHRS), and suppress vibration/bumps.
- **Phase 3**: Train an ML forward velocity model on the [IO-VNBD dataset](https://github.com/onyekpeu/IO-VNBD), integrate with an Error-State Kalman Filter (ESKF) for seamless GNSS + INS dead reckoning, and package as `HybridIdrLocationProvider`.
