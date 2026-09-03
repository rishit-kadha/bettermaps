# BetterMaps 🧭
### AI-ML based Intelligent Dead Reckoning System for Seamless Navigation
*Smart India Hackathon (SIH) Solution*

BetterMaps is a smartphone navigation application engineered to provide seamless, accurate positioning when GNSS/GPS is unavailable (tunnels, underground parking structures, urban canyons, or dense tree canopies).

---

## ⚠️ Critical Distinction: Expo Go vs. Custom Expo Development Build

> [!IMPORTANT]
> **DO NOT USE STANDARD EXPO GO FOR THIS PROJECT.**
> Standard Expo Go (from the Google Play Store) is a pre-compiled, generic sandbox. It **cannot load custom native Android manifests, proprietary native SDKs, or custom Google Maps Android API keys** tied to your app's package identity (`com.sih.bettermaps`). Attempting to run this project in standard Expo Go causes blank map tiles, missing native module errors, or immediate initialization crashes.

### Which Environment Should You Use?

1. **Android Studio / Local Native Build (`npx expo run:android`)**:
   - Compiles the project's native `android/` directory directly on your computer.
   - Ideal for day-to-day development using the **Android Emulator**, inspecting native logs via **Logcat**, running on a connected **physical phone via USB**, and preparing Phase 2 & 3 C++/JNI native sensor code.
2. **Custom Expo Development Build (`expo-dev-client`) via EAS**:
   - Produces a custom debug `.apk` that bakes in Google Play Services Maps SDK and your Google Maps API key.
   - Ideal for testing on a physical Android phone without needing local Android Studio / JDK on your PC. It still connects wirelessly to Metro for instant **Fast Refresh**.

---

## Architecture: Shared React Native UI + Native Platform Adapters

```
                    React Native App
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
        UI          Navigation      App State
          │
          ▼
   Platform-neutral
   interfaces / bridge
          │
    ┌─────┴─────┐
    │           │
    ▼           ▼
 Android      iOS
 Adapter      Adapter
    │           │
    ├── GNSS    ├── GNSS
    ├── IMU     ├── IMU
    ├── Gyro    ├── Gyro
    ├── Mag     ├── Mag
    └── IDR     └── IDR
```

- **Shared React Native Frontend**: [`src/components/`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/components) (Map abstraction, Vehicle Marker, HUD, Diagnostics).
- **Location Adapters**: Platform-independent [`ILocationProvider`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/core/types/location.ts) implemented via [`AndroidGnssLocationProvider`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/adapters/location/AndroidGnssLocationProvider.ts) (Phase 1) and [`IosGnssLocationProvider`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/adapters/location/IosGnssLocationProvider.ts).
- **Sensor Adapters**: Normalized [`ImuSample`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/core/types/imu.ts) representation streaming from [`AndroidImuProvider`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/adapters/imu/AndroidImuProvider.ts) (Android `SensorManager`).
- **Map Isolation**: [`MapContainer.tsx`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/components/map/MapContainer.tsx) isolates Google Maps SDK (`PROVIDER_GOOGLE`) completely behind an application component.

---

## Google Maps API Key Configuration

The Google Maps Android API key is injected dynamically during prebuild into `android/app/src/main/AndroidManifest.xml`:

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Set your Google Maps Android API key:
   ```env
   EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=AIzaSy...
   ```
   *(Ensure **Maps SDK for Android** is enabled in your [Google Cloud Console](https://console.cloud.google.com/)).*

> [!NOTE]
> - **Local Builds**: `npx expo prebuild` reads `.env` and updates `<meta-data android:name="com.google.android.geo.API_KEY" android:value="..."/>` in `AndroidManifest.xml`.
> - **EAS Cloud Builds**: `.easignore` explicitly preserves `.env` during upload, ensuring the key is baked into cloud APKs without exposing secrets in Git.

---

## Running BetterMaps

### Workflow 1: Android Studio & Local Native Development (Recommended for Day-to-Day Development)

This workflow gives you access to the **Android Emulator**, live **Logcat** debugging, and instant **Fast Refresh**.

#### 1. Setup Requirements
* **Android Studio**: Android Studio Koala / Ladybug / Meerkat (2024.1+) or newer.
* **JDK**: **OpenJDK 17** (Ensure `JAVA_HOME` points to JDK 17).
* **Android SDK Platforms**: Android 15 (`API 35`) and/or Android 14 (`API 34`).
* **Android SDK Build-Tools**: `35.0.0` or `34.0.0`.
* **Android SDK Platform-Tools**: Installed (provides `adb`).
* **Environment Variables**:
  * `ANDROID_HOME`: `C:\Users\<Username>\AppData\Local\Android\Sdk`
  * Add to `PATH`: `%ANDROID_HOME%\platform-tools`, `%ANDROID_HOME%\emulator`, and `%JAVA_HOME%\bin`.

#### 2. Emulator Configuration
* In Android Studio, open **Virtual Device Manager**.
* Create a device (e.g. **Pixel 8** or **Pixel 7**).
* **System Image**: Choose an image with **Google Play** or **Google APIs** (API 34 or 35). *Google Maps requires Google Play Services to render.*
* **GPS Simulation**: On the emulator toolbar, click `...` (Extended Controls) -> **Location** to set manual coordinates or play a route.

#### 3. Physical Phone USB Setup
* On your phone: **Settings** -> **About Phone** -> Tap **Build Number** 7 times.
* **Settings** -> **Developer Options** -> Enable **USB Debugging**.
* Connect phone to PC via USB. Run `adb devices` to verify connection.

#### 4. Exact Execution Commands
```bash
# 1. Install dependencies
npm install

# 2. Synchronize native Android project with .env credentials
npx expo prebuild -p android

# 3. Start Metro bundler (in a separate terminal)
npx expo start

# 4. Launch on Android Emulator (ensure emulator is started)
npx expo run:android

# 5. OR launch on connected physical Android phone
npx expo run:android --device
```
*(Alternatively, open the `android/` directory in Android Studio and click the green **Run** `▶` button).*

---

### Workflow 2: Expo Development Build via EAS (Alternative for Physical Device Testing)

This workflow is ideal if you want to test on a physical Android phone without installing Android Studio or the Android SDK on your PC.

#### 1. Build the Development APK
```bash
# Install EAS CLI globally if not already installed
npm install -g eas-cli

# Log in to your Expo account
npx eas-cli login

# Build custom development APK using configured eas.json
npx eas-cli build --profile development --platform android
```

#### 2. Install on Physical Android Phone
* When the build completes, EAS prints a **QR code and download link**.
* Open the link in your phone browser, download `bettermaps-dev.apk`, and install it.

#### 3. Connect to Metro & Live Fast Refresh
```bash
# Start Metro in development-client mode
npx expo start --dev-client

# (If PC and phone are on different Wi-Fi bands or behind AP isolation)
npx expo start --dev-client --tunnel
```
* Open the **BetterMaps** app on your phone.
* Tap your local Metro server listed in the dev-client launcher (or scan the terminal QR code from within the dev-client).
* Edit any TypeScript file in `src/` to see instant Fast Refresh!

---

## Acceptance & Testing Checklist

Use this checklist to verify your environment and Phase 1 functionality:

```text
[ ] Android Studio can open the project (pointing to the android/ directory)
[ ] Android emulator can launch BetterMaps (Google Play system image)
[ ] Physical Android phone can launch BetterMaps (via USB debugging or dev APK)
[ ] Google Map renders taking 100% of the screen
[ ] Location permission prompt appears and handles Grant/Deny
[ ] Phone GNSS location appears as vehicle position
[ ] Vehicle marker updates with heading chevron while moving
[ ] Recenter FAB re-locks camera to vehicle after manual map panning
[ ] Compass button toggles between Course-Up (3D tilt) and North-Up (2D)
[ ] Debug panel displays live coordinates, accuracy, and rolling update Hz
[ ] Metro / Fast Refresh works when modifying React Native code
[ ] EAS development APK can be built (via eas.json)
[ ] EAS development APK can be installed on Android phone
[ ] Development APK connects to local Metro server over Wi-Fi
```

---

## Phase 2 & 3 Roadmap: Intelligent Dead Reckoning

- **Phase 2 (Inertial Sensing)**: Ingest `SensorManager` (Accelerometer, Gyroscope, Magnetometer @ 50–100Hz) inside `android/` and apply vibration/pothole filtering.
- **Phase 3 (AI/ML Engine)**: Train a 1D-CNN / GRU on the [IO-VNBD dataset](https://github.com/onyekpeu/IO-VNBD) to estimate forward vehicle velocity during GNSS outages, implement an Error-State Kalman Filter (ESKF), and package as `HybridIdrLocationProvider`.
