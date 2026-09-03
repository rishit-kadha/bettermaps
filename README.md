# BetterMaps 🧭
### AI-ML based Intelligent Dead Reckoning System for Seamless Navigation
*Smart India Hackathon (SIH) Solution*

BetterMaps is a smartphone navigation application engineered to provide seamless, accurate positioning when GNSS/GPS is unavailable (tunnels, underground parking structures, urban canyons, or dense tree canopies).

---

## ⚠️ Important Note on Expo Go & Google Maps Compatibility

### Root Cause of Failure in Standard Expo Go:
If you tried scanning the QR code with standard **Expo Go from Google Play Store**, it fails because:
1. **Native Google Maps SDK (`PROVIDER_GOOGLE`) Requirement**:
   Google Maps on Android requires native Google Play Services Maps SDK and your custom API key baked into the native `AndroidManifest.xml` (`com.google.android.geo.API_KEY`). The generic, pre-compiled Expo Go client from the Play Store **cannot authorize your custom package identifier (`com.sih.bettermaps`) or API key**, causing native initialization failures or blank map tiles.
2. **Expo SDK 57 Support**:
   Expo Go from the Play Store supports older SDK versions. This project uses the modern Expo SDK 57, which requires a **Development Build**.

### The Clean Solution: Option A (Expo Development Build / Prebuild)
Rather than forcing Google Maps into a restricted generic container, we adopt **Option A — Development Build**:
- Native Google Maps and permissions are compiled directly into a custom debug APK.
- The app still uses **Metro hot-reloading** over Wi-Fi — you can modify TypeScript code and see instant updates without re-compiling!
- Gives us full access to the native `android/` directory, which is required in **Phase 2 & 3** to hook into Android's high-rate `SensorManager` (50–200 Hz) and C++/JNI dead reckoning engine.

---

## Architecture: Decoupled Positioning Pipeline

```
UI Layer (NavigationMap, VehiclePuck, NavigationHUD, DiagnosticsPanel)
        │
        ▼ (Subscribes to NavLocation & NavigationTelemetry)
Navigation State (NavigationManager: circular heading filter, update Hz, camera modes)
        │
        ▼ (Consumes ILocationProvider interface)
LocationProvider Abstraction
   ├── GnssLocationProvider (Phase 1: Android FusedLocationProviderClient)
   ├── MockLocationProvider (Phase 1: Route simulation & tunnel/outage toggle)
   └── HybridIdrLocationProvider (Phase 2 & 3: IMU + IO-VNBD ML + Strapdown INS)
```

---

## Quick Setup: Run on Physical Android Phone

### Step 1: Configure Your Google Maps API Key
1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and set your key:
   ```env
   EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=AIzaSy...
   ```
   *(Ensure **Maps SDK for Android** is enabled in [Google Cloud Console](https://console.cloud.google.com/)).*

---

### Step 2: Install the Development Build on Your Android Phone

Choose **Method 1 (Cloud EAS Build - Easiest)** OR **Method 2 (Local USB Build)**:

#### Method 1: Cloud Build via EAS (Zero Android Studio or JDK needed)
If you do not have 15 GB of Android Studio and JDK installed on your PC:
1. Install EAS CLI:
   ```bash
   npm install -g eas-cli
   ```
2. Log in (or create a free Expo account):
   ```bash
   npx eas-cli login
   ```
3. Build the development APK:
   ```bash
   npx eas-cli build --profile development --platform android
   ```
4. Once completed, EAS will print a **QR code and download link**. Open the link on your Android phone, download the `.apk`, and tap **Install**.

---

#### Method 2: Local Build via USB Debugging
If you have Android Studio and JDK 17 installed:
1. Connect your Android phone to your PC via USB cable.
2. Enable **Developer Options** and **USB Debugging** on your phone.
3. Verify connection:
   ```bash
   adb devices
   ```
4. Build and install directly onto your phone:
   ```bash
   npx expo run:android
   ```

---

### Step 3: Start Metro Bundler & Live Test
Once the development build is installed on your phone:
1. Start the Metro server:
   ```bash
   npm start
   ```
   *(Note: If on separate networks or using WSL/Hyper-V, run `npm start -- --tunnel`)*
2. Open the **BetterMaps** app on your phone.
3. It will connect to your local Metro server automatically over Wi-Fi.
4. You now have full native Google Maps, live GPS tracking, and instant hot-reloading!

---

## Verification & Acceptance Checklist

| Step | Action | Expected Result |
| :--- | :--- | :--- |
| **1. Launch** | Open BetterMaps on Android | Native Google Map renders taking 100% of the screen. |
| **2. Permission** | Prompt appears | Tapping **Grant** enables fine location; status pill turns green (`GNSS 3D FIX`). |
| **3. Live Position** | Observe map | Vehicle puck appears at your exact physical location. |
| **4. Heading Tracking** | Move with phone | Directional chevron aligns with vehicle heading. When stationary, chevron gracefully hides to prevent jitter. |
| **5. Navigation Camera** | Let vehicle move | Camera follows position smoothly in 3D driving perspective (45° tilt). |
| **6. Free Look & Recenter** | Pan map manually | Camera follow disengages; floating **Recenter** FAB turns blue. Tapping it animates camera back to vehicle. |
| **7. Compass** | Tap compass needle | Toggles between Course-Up (3D tilted) and North-Up (2D top-down) mode. |
| **8. Diagnostics Panel** | Tap **Diagnostics** | Live debug panel displays coordinates, speed, accuracy, and **real-time update frequency in Hz**. |

---

## Phase 2 & 3 Roadmap: Intelligent Dead Reckoning

- **Phase 2 (Inertial Sensing)**: Ingest `SensorManager` (Accelerometer, Gyroscope, Magnetometer @ 50–100Hz) inside `android/` and apply vibration/pothole filtering.
- **Phase 3 (AI/ML Engine)**: Train a 1D-CNN / GRU on the [IO-VNBD dataset](https://github.com/onyekpeu/IO-VNBD) to estimate forward vehicle velocity during GNSS outages, implement an Error-State Kalman Filter (ESKF), and package as `HybridIdrLocationProvider`.
