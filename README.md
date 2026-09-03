# BetterMaps 🧭

### AI-ML based Intelligent Dead Reckoning System for Seamless Navigation

_Smart India Hackathon (SIH) Solution_

BetterMaps is a smartphone navigation application engineered to provide seamless, accurate positioning when GNSS/GPS is unavailable (in tunnels, underground parking structures, urban canyons, or under dense tree canopies).

---

### Phase 1 Deliverables

Phase 1 delivers a clean, modern Android navigation shell with a completely decoupled architecture:
- **Google Maps Integration**: Native Google Maps rendering on Android via `react-native-maps` (`PROVIDER_GOOGLE`).
- **Decoupled Architecture**: Strict `ILocationProvider` interface contract. Map and camera components have zero direct coupling with Android location APIs.
- **Phone GNSS Provider**: `GnssLocationProvider` streaming real-time coordinates, course heading, and speed from Android's `FusedLocationProviderClient`.
- **Live GNSS Diagnostics Panel**: Real-time telemetry overlay displaying:
  - Exact coordinates (`latitude`, `longitude`, `altitude`)
  - Speed (`km/h` and `m/s`)
  - Course heading and heading reliability status
  - Horizontal accuracy (`± meters`)
  - **Live update frequency in approximate Hz** (calculated via rolling window)
  - Current provider tag: `GNSS`
- **Heading-Aware Vehicle Puck**:
  - Displays a high-visibility directional chevron when moving with reliable GPS heading.
  - Switches to a stable circular location puck when stationary to prevent noisy visual spinning.
- **Navigation Camera**:
  - **Course-Up**: 3D driving perspective (45° tilt) aligned with vehicle course.
  - **North-Up**: 2D top-down perspective facing True North.
  - **Free-Look**: User can pan and inspect surroundings freely.
  - **Recenter FAB**: Instantly flies camera back to the vehicle and re-locks navigation tracking.
- **Permission & Safety Handling**:
  - Explicit status pill (`GNSS 3D FIX`, `ACQUIRING GNSS...`, `NO PERMISSION`, `GPS DISABLED`).
  - Interactive permission recovery banner if permission was previously denied.
  - Helpful alert if GPS / location services are disabled in device settings.
- **Secure Environment Configuration**:
  - Google Maps API key loaded dynamically via `.env` (`EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`) and `app.config.ts`.
  - Secrets are never hardcoded into source control.

---

## Project Structure

```
bettermaps/
├── src/
│   ├── types/
│   │   └── location.ts            # ILocationProvider, NavLocation, NavigationTelemetry
│   ├── providers/
│   │   ├── GnssLocationProvider.ts # Native Android GNSS via FusedLocationProviderClient
│   │   ├── MockLocationProvider.ts # Route simulator & GNSS outage toggle
│   │   └── index.ts               # Provider registry & runtime factory
│   ├── services/
│   │   └── NavigationManager.ts   # Navigation state, update Hz calculator, circular heading filter
│   └── components/
│       ├── NavigationMap.tsx      # Google Maps view, vehicle marker, animated camera
│       ├── VehiclePuck.tsx        # Orientation chevron + stationary circular puck
│       ├── NavigationHUD.tsx      # Modern floating controls: compass, recenter, status pill, bottom dock
│       └── DiagnosticsPanel.tsx   # Live GNSS diagnostics overlay (Hz, accuracy, speed, lat/lon)
├── App.tsx                        # Main entry point wiring UI and state
├── app.config.ts                  # Dynamic Expo config reading .env safely
├── app.json                       # Android permissions, package name, base config
├── .env.example                   # Template for Google Maps API Key
├── ARCHITECTURE.md                # In-depth system architecture & IDR roadmap
└── README.md
```

---

## Physical Android Phone Setup Guide

### 1. Prerequisites
- Install **Node.js** (v18+) on your computer.
- Install the **Expo Go** app on your Android phone from the [Google Play Store](https://play.google.com/store/apps/details?id=host.exp.exponent).

### 2. Configure Google Maps API Key (No Hardcoded Secrets)
1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and paste your Google Maps Android API key:
   ```env
   EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=AIzaSy...
   ```
   *(Note: For testing in Expo Go on Android, maps will render using Expo's bundled development credentials even before you add a custom key. For standalone APK builds, your own key is used.)*

### 3. Start the Development Server
Run:
```bash
npm start
```
A QR code will appear in your terminal.

### 4. Connect Your Android Phone
1. Connect your Android phone to the same Wi-Fi network as your computer (or run `npm start -- --tunnel` if on different networks/cellular).
2. Open **Expo Go** on your phone.
3. Tap **Scan QR code** and point your phone at the terminal QR code.
4. The JavaScript bundle will download and the app will open directly on your phone!

---

## Definition of Done Verification Checklist

| Step | Action | Expected Behavior |
| :--- | :--- | :--- |
| **1. Launch** | Open the app on Android | Google Map renders taking 100% of the screen. |
| **2. Permission** | Dialog prompts for Location | Tapping **Allow** grants fine location permission; top pill changes to `GNSS 3D FIX`. |
| **3. Live Position** | Look at the map | Vehicle puck appears at your exact physical coordinates. |
| **4. Movement** | Walk or drive | Vehicle puck updates smoothly; speedometer displays live speed; breadcrumbs trail follows behind. |
| **5. Heading** | Moving in a direction | Directional chevron points along your course heading. When stationary, chevron gracefully hides. |
| **6. Camera Follow** | Let the vehicle move | Camera follows your vehicle smoothly in 3D perspective (Course-Up). |
| **7. Manual Pan** | Drag the map | Camera tracking disengages; floating **Recenter** button lights up in blue. |
| **8. Recenter** | Tap **Recenter** | Camera smoothly animates back to your position and re-locks navigation tracking. |
| **9. Compass** | Tap the compass needle | Toggles between Course-Up (3D tilted) and North-Up (2D top-down) mode. |
| **10. Diagnostics** | Tap **Diagnostics** | Debug overlay opens showing live `Hz`, speed, accuracy, heading, and coordinates. |

---

## Next Steps: Future Phases

- **Phase 2 (Inertial Sensing)**: Integrate smartphone `SensorManager` (Accelerometer, Gyroscope, Magnetometer @ 50-100Hz) and implement vibration/pothole filtering.
- **Phase 3 (AI/ML Dead Reckoning Engine)**: Train a 1D-CNN / GRU on the [IO-VNBD dataset](https://github.com/onyekpeu/IO-VNBD) to estimate forward vehicle velocity during GNSS outages, implement an Error-State Kalman Filter (ESKF), and package as `HybridIdrLocationProvider` behind the existing `ILocationProvider` interface.
