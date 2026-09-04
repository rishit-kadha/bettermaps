# BetterMaps 🧭

### AI-ML based Intelligent Dead Reckoning System for Seamless Navigation

_Smart India Hackathon (SIH) Solution_

BetterMaps is a smartphone navigation application engineered to provide seamless, accurate positioning when GNSS/GPS is unavailable (tunnels, underground parking structures, urban canyons, or dense tree canopies).

---

### 📚 Essential Project Documentation
- 🚀 **[Team & AI Agent Startup Guide](docs/STARTUP_GUIDE.md)**: Prerequisites, environment setup, and 3 ways to get the app running on physical Android phones.
- 📦 **[Training Dataset & Data Architecture Guide](docs/DATASET_GUIDE.md)**: IO-VNBD dataset audit, session inventory, coordinate transformations, normalization, and splits.
- 🔬 **[Phase 5 IDR Training & Research Report](artifacts/reports/IDR_TRAINING_REPORT.md)**: Quantitative evaluation of classical vs neural baselines, loss sweeps, locked test evaluation, and multi-outage dead reckoning.

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
   _(Ensure **Maps SDK for Android** is enabled in your [Google Cloud Console](https://console.cloud.google.com/))._

> [!NOTE]
>
> - **Local Builds**: `npx expo prebuild` reads `.env` and updates `<meta-data android:name="com.google.android.geo.API_KEY" android:value="..."/>` in `AndroidManifest.xml`.
> - **EAS Cloud Builds**: `.easignore` explicitly preserves `.env` during upload, ensuring the key is baked into cloud APKs without exposing secrets in Git.

---

## Running BetterMaps

### Workflow 1: Android Studio & Local Native Development (Recommended for Day-to-Day Development)

This workflow gives you access to the **Android Emulator**, live **Logcat** debugging, and instant **Fast Refresh**.

#### 1. Setup Requirements

- **Android Studio**: Android Studio Koala / Ladybug / Meerkat (2024.1+) or newer.
- **JDK**: **OpenJDK 17** (Ensure `JAVA_HOME` points to JDK 17).
- **Android SDK Platforms**: Android 15 (`API 35`) and/or Android 14 (`API 34`).
- **Android SDK Build-Tools**: `35.0.0` or `34.0.0`.
- **Android SDK Platform-Tools**: Installed (provides `adb`).
- **Environment Variables**:
  - `ANDROID_HOME`: `C:\Users\<Username>\AppData\Local\Android\Sdk`
  - Add to `PATH`: `%ANDROID_HOME%\platform-tools`, `%ANDROID_HOME%\emulator`, and `%JAVA_HOME%\bin`.

#### 2. Emulator Configuration

- In Android Studio, open **Virtual Device Manager**.
- Create a device (e.g. **Pixel 8** or **Pixel 7**).
- **System Image**: Choose an image with **Google Play** or **Google APIs** (API 34 or 35). _Google Maps requires Google Play Services to render._
- **GPS Simulation**: On the emulator toolbar, click `...` (Extended Controls) -> **Location** to set manual coordinates or play a route.

#### 3. Physical Phone USB Setup

- On your phone: **Settings** -> **About Phone** -> Tap **Build Number** 7 times.
- **Settings** -> **Developer Options** -> Enable **USB Debugging**.
- Connect phone to PC via USB. Run `adb devices` to verify connection.

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

_(Alternatively, open the `android/` directory in Android Studio and click the green **Run** `▶` button)._

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

- When the build completes, EAS prints a **QR code and download link**.
- Open the link in your phone browser, download `bettermaps-dev.apk`, and install it.

---

## Testing on a Physical Android Phone

BetterMaps is built to run identically on both the **Android Emulator** and a **physical Android phone** using the exact same React Native + custom Expo development build (`com.sih.bettermaps`).

### 1. Physical Phone Prerequisites

1. **Enable Developer Options on Phone**:
   - Open **Settings** -> **About phone**.
   - Scroll to **Build number** and tap it **7 times** until you see _"You are now a developer!"_.
2. **Enable USB Debugging**:
   - Open **Settings** -> **System** (or Additional Settings) -> **Developer options**.
   - Toggle **USB Debugging** to **ON**.
   - _(Optional for Xiaomi/MIUI/HyperOS/Oppo/Vivo/Realme)_: Enable **"Install via USB"** and **"USB debugging (Security settings)"** if prompted.
3. **Connect to PC & Authorize**:
   - Connect your phone to the PC via a USB cable.
   - Look at the phone screen for the prompt: _"Allow USB debugging?"_.
   - Check **"Always allow from this computer"** and tap **Allow**.
4. **Verify ADB on Windows**:
   In PowerShell:
   ```powershell
   $env:PATH = "$env:LOCALAPPDATA\Android\Sdk\platform-tools;$env:PATH"
   adb devices -l
   ```
   Your phone must appear with the state **`device`** (e.g., `RF8N... device ...`). If it shows `unauthorized`, unlock your phone and tap Allow. If it is missing, install your phone manufacturer's official USB driver (e.g., Samsung Smart Switch / Google USB Driver / OEM Driver).

---

### 2. Option A (Preferred): Local USB Development

Because the phone is connected via USB, you can use **ADB Port Reversal**. This routes all bundle traffic directly through the USB cable, completely bypassing Wi-Fi router client isolation and Windows firewall issues!

#### Step-by-Step Commands:

```powershell
# 1. Reverse port 8081 so the physical phone can reach Metro over USB
npm run android:reverse
# (Equivalent to: adb reverse tcp:8081 tcp:8081)

# 2. Start Metro in dev-client mode (in Terminal 1)
npm run start:dev

# 3. Build & install the BetterMaps dev build onto your physical phone (in Terminal 2)
npm run android:device
```

_(Alternatively, to install the precompiled debug APK directly to the connected phone without rebuilding)_:

```powershell
$env:PATH = "$env:LOCALAPPDATA\Android\Sdk\platform-tools;$env:PATH"
adb -d install -r android\app\build\outputs\apk\debug\app-debug.apk
adb -d shell monkey -p com.sih.bettermaps -c android.intent.category.LAUNCHER 1
```

Once opened:

- BetterMaps connects to Metro automatically.
- Grant location permissions when prompted.
- Move or walk with the phone to see live GPS updates, heading chevron rotation, speed, and accuracy!

---

### 3. Option B: EAS Cloud Development APK

If you prefer testing without a USB cable:

1. Build the custom development APK in the cloud:
   ```powershell
   npx eas-cli build --profile development --platform android
   ```
2. Scan the resulting QR code or download the APK directly on your phone and install it.
3. Start Metro on your computer:

   ```powershell
   # If PC and Phone are on the same Wi-Fi network:
   npm run start:dev

   # If LAN is blocked by router isolation or firewall, use tunnel:
   npm run start:tunnel
   ```

4. Open the installed **BetterMaps** app on your phone, and tap the local development server (or scan the terminal QR code from within the BetterMaps launcher).

---

### 4. Google Maps API Key & SHA-1 Restrictions

- **Local USB Development**: The APK built locally uses `android/app/debug.keystore`:
  - **Package Name**: `com.sih.bettermaps`
  - **SHA-1 Fingerprint**: `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`
  - This matches the key restrictions already configured for the project. **No Google Cloud changes are required.**
- **EAS Cloud Builds**: If you build using EAS, EAS uses its own cloud keystore. Check its SHA-1 with `npx eas-cli credentials` and add that SHA-1 fingerprint to your Google Cloud Console under the `com.sih.bettermaps` package restriction.

---

---

## Real Navigation Engine (Phase 1 Evolution)

BetterMaps includes a turn-by-turn driving navigation engine built on Google Maps Platform services, while strictly preserving the positioning abstraction so the future AI-ML Intelligent Dead Reckoning (IDR) engine can replace GNSS as the underlying position source.

### Architecture

```text
               React Native UI
                      │
              Destination Search
                      │
               NavigationManager (State & Progress)
                      │
               LocationProvider
               ┌──────┴──────┐
               │             │
              GNSS          IDR (Future)
           (Android)      (Neural/IMU)
```

1. **Clean Separation of Positioning & Navigation**:
   - `LocationProvider`: Exposes normalized coordinate, accuracy, speed, heading, and provider status.
   - `NavigationManager`: Maintains the active route, computes along-track progress, tracks maneuvers, and broadcasts telemetry to UI subscribers.
   - **Provider Independence**: Switching between `native_gnss`, `mock`, or the upcoming `idr` provider does not interrupt or restart the active route.

2. **Google Cloud Services & Key Discipline**:
   - **Maps SDK for Android**: Map rendering via native Google Play services (`PROVIDER_GOOGLE`), authenticated via Android manifest meta-data restricted by Package Name (`com.sih.bettermaps`) and SHA-1 certificate fingerprint.
   - **Places API (New)**: Autocomplete destination search with session token billing discipline and 380ms debouncing.
   - **Routes API (v2)**: Driving route computation, returning encoded polyline, step-by-step turn instructions, and maneuvers.
   - **Configuration**: Set `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` in `.env`. For segregated architectures, an optional `EXPO_PUBLIC_GOOGLE_SERVICES_API_KEY` can be provided for web-service REST calls.
   - **Android Client Verification**: Mobile REST requests transmit `X-Android-Package` and `X-Android-Cert` headers to comply with Google Cloud Android restrictions.
   - **Zero Silent Fake Routing**: If API keys or quotas fail, the application presents a clear diagnostic notice without generating synthetic straight-line routes.

3. **Geometric Route Progress Engine**:
   - **Orthogonal Segment Projection**: Rather than naively measuring Euclidean distance to the nearest vertex, the vehicle's position is orthogonally projected onto each route polyline segment $[P_i, P_{i+1}]$ using metric equirectangular displacements:
     $$t = \text{clamp}\left(\frac{\Delta x_p \Delta x_s + \Delta y_p \Delta y_s}{\Delta x_s^2 + \Delta y_s^2}, 0, 1\right)$$
   - **Monotonic Along-Track Progress**: To prevent GPS jitter or stationary noise from causing the route progress to bounce backward, along-track distance traveled is strictly monotonically non-decreasing:
     $$\text{traveled} = \max(\text{traveled}_{\text{prev}}, s_i + t \cdot d_i)$$
   - **Maneuver Boundary Advancement**: Each navigation step contains precomputed cumulative start and end distances along the route. Steps advance automatically when along-track traveled distance crosses the step's cumulative boundary.
   - **Cross-Track & Arrival Detection**: Tracks perpendicular cross-track deviation ($>45\,\text{m}$ flags off-route) and arrival radius ($<25\,\text{m}$ triggers arrival state).

4. **Offline Development / Simulator Mode**:
   - When running on an emulator or in testing without active Google Places/Routes quota, tapping the search bar allows loading an explicit **Simulator Test Route** (Connaught Place Loop) that exercises the complete navigation lifecycle, 3D driving tilt, turn banners, and ETA calculations.

---

---

## Phase 2: Native Smartphone Sensor Acquisition & Recording Engine

BetterMaps Phase 2 implements a research-grade, high-frequency sensor acquisition and recording foundation designed specifically for training and evaluating future **Intelligent Dead Reckoning (IDR)** models.

### 1. High-Performance Decoupled Native Architecture

To avoid routing 100–400 Hz IMU streams through the React Native JavaScript bridge (which introduces GC stutter, queue overflow, and UI lag), the engine uses a completely decoupled native pipeline:

- **Dedicated Callback Thread**: `SensorEventListener` callbacks execute on a high-priority background `HandlerThread("BetterMapsSensorThread")`.
- **Authoritative Monotonic Timestamps**: Native `event.timestamp` in nanoseconds (backed by Linux `SystemClock.elapsedRealtimeNanos()`) is preserved as the canonical ground-truth clock for both IMU events and GNSS fixes.
- **Lock-Free In-Memory Queue**: Sensor events are non-blockingly queued into a bounded `LinkedBlockingQueue` (50,000 capacity).
- **Background Disk Writer Thread**: File I/O is completely decoupled from the sensor callback thread, streaming directly to disk using 32 KB buffered writers.
- **Throttled Telemetry (~5 Hz)**: React Native receives only batched, throttled telemetry for live UI gauges and status indicators.

### 2. Independent Sensor Streams & Storage Format

Each recording session produces an isolated directory under `/storage/emulated/0/Android/data/com.sih.bettermaps/files/sessions/<sessionId>/`:

- `metadata.json`: Device specifications, sensor hardware models, vendor info, resolution, range, and end-of-session data-integrity statistics.
- `accelerometer.csv`: Raw 3-axis acceleration ($m/s^2$) in Android sensor frame ($+X$ right, $+Y$ up, $+Z$ out) including gravity vector.
- `gyroscope.csv`: Raw 3-axis angular velocity ($rad/s$) in Android sensor frame.
- `magnetometer.csv`: Raw 3-axis ambient magnetic field ($\mu T$).
- `orientation.csv`: Derived device attitude (roll, pitch, yaw) in both radians and degrees from Android rotation vector (tagged as reference, not ground truth).
- `gnss.csv`: Reference location fixes from Android Fused Location Provider with latitude, longitude, altitude, accuracy, speed, bearing, and source provider.

### 3. Verification & Analysis Tooling

Pull recorded sessions from a connected phone via ADB:

```powershell
adb pull /storage/emulated/0/Android/data/com.sih.bettermaps/files/sessions/<sessionId> ./captured_sessions/
```

Inspect session integrity, calculate jitter distributions, verify timestamp monotonicity, and check physical gravity norms:

```powershell
python scripts/verify_session.py ./captured_sessions/<sessionId>
```

---

## Acceptance & Testing Checklist

Use this checklist to verify your environment and Phase 1 & 2 functionality:

```text
[x] Android Studio can open the project (pointing to the android/ directory)
[x] Android emulator can launch BetterMaps (Google Play system image)
[x] Physical Android phone can launch BetterMaps (via USB debugging or dev APK)
[x] Google Map renders taking 100% of the screen
[x] Location permission prompt appears and handles Grant/Deny
[x] Phone GNSS location appears as vehicle position
[x] Vehicle marker updates with heading chevron while moving
[x] Recenter FAB re-locks camera to vehicle after manual map panning
[x] Compass button toggles between Course-Up and North-Up
[x] Debug panel displays live coordinates, accuracy, and rolling update Hz
[x] Metro / Fast Refresh works when modifying React Native code
[x] Destination Search with Places Autocomplete and session tokens
[x] Driving Route calculation via Google Routes API
[x] Dual-casing route polyline rendered on Google Maps
[x] Route preview card with duration, distance, and "Start navigation"
[x] 2D top-down map default (pitch = 0) with optional 3D navigation perspective toggle
[x] Dedicated [ 2D / 3D ] FAB control preserving user camera preference
[x] Top Maneuver Banner with turn icons, distance-to-turn, and instructions
[x] Bottom Active Navigation HUD with remaining km, minutes, and clock ETA
[x] Live positioning source badge (GNSS LIVE / SIMULATOR / DEAD RECKONING)
[x] Route remains active and uninterrupted when switching location providers
[x] Native Kotlin Sensor Module with HandlerThread & decoupled queue
[x] Raw Accelerometer, Gyroscope, Magnetometer, Orientation, and GNSS captured to separate CSVs
[x] Authoritative nanosecond timestamps (timestamp_ns) from elapsedRealtimeNanos
[x] 0 dropped samples, 0 duplicate timestamps, 0 monotonicity violations
[x] Concurrent sensor recording while Google Maps driving navigation is active
[x] Python session inspection and statistical validation tooling (scripts/verify_session.py)
```

---

## Phase 4: Dataset Replay Harness & Route Constraints (Completed)

- [x] Stream real IO-VNBD smartphone IMU data directly into BetterMaps Android application.
- [x] Package calibrated 10 Hz S1 session fixture (`assets/datasets/S1_clean_10hz.json`).
- [x] Multi-layer Google Maps visualization: Ground-truth reference trajectory vs. Pure dead reckoning vs. Route-constrained estimate.
- [x] Simulated GNSS outages with real-time positioning engine fallback.
- [x] Map-matched orthogonal route projection and heading convergence.

---

## Phase 5: IDR ML Training Pipeline & Baseline Experiments (Completed)

- [x] Audited all 72 IO-VNBD sessions (`artifacts/data/session_inventory.csv`, 29.7 driving hours).
- [x] Dynamic Rodrigues gravity leveling and mounting azimuth frame calibration ($\mathbf{R}_{D \to V}$).
- [x] Two-stage time synchronization ($\tau^*$) eliminating smartphone GPS receiver latency.
- [x] 100% session-level Train / Val / Test splitting with strict test-set locking.
- [x] Evaluated classical baselines (B0.1 Mean, B0.2 Persistence, B0.3 Ridge) and neural baselines (B1 MLP, B2 TCN, B3 GRU).
- [x] Controlled loss weight sweep ($\lambda_\omega \in [0.1, 4.0]$), establishing $\lambda_\omega^* = 0.5$ as the optimal trade-off.
- [x] Final locked test-set evaluation: **Tiny Causal TCN cuts velocity RMSE to 15.64 km/h** (32.4% error reduction over Ridge).
- [x] Multi-outage trajectory dead-reckoning benchmark across 3,089 non-overlapping intervals (5s, 10s, 20s, 30s, 60s).
- [x] Heteroscedastic Gaussian uncertainty head with variance clamping and empirical reliability calibration.
- [x] Native 10 Hz vs 50 Hz resampled benchmark: 10 Hz uses $<1\%$ mobile CPU core (0.958 ms/inference), while 50 Hz requires 8.2× higher compute without trajectory gains.

---

## Phase 6 Roadmap: On-Device Mobile Inference & ESKF Fusion

- **ONNX Mobile Export**: Export the winning `TinyCausalTcnMotionModel` (4,962 parameters) to ONNX format with float32/int8 quantization.
- **On-Device Inference**: Integrate ONNX Runtime Mobile / TFLite into the Android native layer.
- **Error-State Extended Kalman Filter (ESKF)**: Fuse learned $[v_f, \omega_z]$ and heteroscedastic covariance $[\sigma_v^2, \sigma_\omega^2]$ with IMU propagation, Non-Holonomic Constraints (NHC), and zero-velocity updates (ZUPT).
- **Production Hybrid Location Provider**: Package the complete IDR engine as `AndroidHybridLocationProvider` adhering to `ILocationProvider`.
