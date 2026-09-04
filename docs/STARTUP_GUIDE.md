# BetterMaps 🧭 — Team & AI Agent Startup Guide

This document is the definitive operational guide for teammates and autonomous AI coding agents working on **BetterMaps**. It covers all prerequisites, environment configuration, multiple methods to run the mobile application on physical Android phones, instructions for running the offline ML/IDR training pipeline, and important troubleshooting steps.

---

## 1. System Overview & Technology Stack

BetterMaps combines a **cross-platform React Native / Expo front-end**, high-frequency **native Android Kotlin sensor services**, and a **Python machine learning research engine** for Intelligent Dead Reckoning (IDR).

- **Mobile App**: React Native `0.86.3` with Expo SDK `57.0.19` (strictly compliant with [Expo v57 docs](https://docs.expo.dev/versions/v57.0.0/)).
- **Map & Routing**: Google Maps SDK for Android (`react-native-maps`), Google Places API (New), and Google Routes API (v2).
- **Native Android Module**: Kotlin `SensorManager` service with a dedicated background `HandlerThread` and a lock-free queue for zero-jitter sensor logging (up to 100–400 Hz).
- **IDR ML Engine**: PyTorch `2.14+`, NumPy, SciPy, scikit-learn, and Pandas for offline training on the IO-VNBD smartphone dataset.

---

## 2. Prerequisites & Environment Setup

### 2.1 Developer Machine Requirements

| Dependency                     | Minimum Version      | Recommended Version                      | Purpose                            |
| :----------------------------- | :------------------- | :--------------------------------------- | :--------------------------------- |
| **Node.js**                    | `v20.x` LTS          | `v20.18.x` or `v22.x`                    | React Native & Expo runtime        |
| **npm**                        | `v10.x`              | Latest bundled                           | Package management                 |
| **Java Development Kit (JDK)** | **JDK 17**           | OpenJDK 17 / Eclipse Temurin 17          | Android Gradle compilation         |
| **Android SDK**                | `API 34` or `API 35` | Android 15 (API 35) + Build-Tools 35.0.0 | Native Android toolchain           |
| **Python**                     | `3.10+`              | `Python 3.11` – `3.14`                   | IDR ML training pipeline & tooling |
| **Expo CLI**                   | Bundled              | `npx expo`                               | Development build orchestrator     |
| **EAS CLI**                    | Latest               | `npm install -g eas-cli`                 | Cloud builds & credentials         |

### 2.2 Environment Variables (Windows PowerShell)

Ensure the following environment variables are set in your system or user profile:

```powershell
# Java JDK 17
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.x-hotspot"

# Android SDK
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = "$env:LOCALAPPDATA\Android\Sdk"

# Path additions
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;$env:PATH"
```

Verify the installation:

```bash
node -v
npm -v
java -version    # Must report version 17.x
adb version
```

### 2.3 Repository Setup & Dependencies

Clone the repository and install npm packages:

```bash
git clone https://github.com/rishit-kadha/bettermaps.git
cd bettermaps
npm install
```

### 2.4 Google Maps API Key Configuration

Create a local `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Add your Google Cloud API key:

```env
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=AIzaSy...your_key_here...
```

> [!IMPORTANT]
>
> - Ensure **Maps SDK for Android**, **Places API (New)**, and **Routes API** are enabled in your [Google Cloud Console](https://console.cloud.google.com/).
> - For local debug builds, the app uses the standard Android debug keystore:
>   - **Package Name**: `com.sih.bettermaps`
>   - **SHA-1 Fingerprint**: `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`

---

## 3. Getting the App Running on Physical Android Phones

> [!CAUTION]
> **DO NOT USE STANDARD EXPO GO.**
> Standard Expo Go from the Play Store does not include custom native Android manifest entries, Google Maps SDK key bindings, or proprietary native sensor modules. You **must** use a Custom Expo Development Build (`com.sih.bettermaps`).

### 3.1 Physical Phone Preparation (One-Time Setup)

1. Open **Settings** -> **About Phone**.
2. Tap **Build Number** 7 times until you see _"You are now a developer!"_.
3. Navigate to **Settings** -> **Developer Options**:
   - Toggle **USB Debugging** -> **ON**.
   - _(On Xiaomi / MIUI / HyperOS / Oppo / Vivo / Realme)_: Also enable **"Install via USB"** and **"USB debugging (Security settings)"**.
4. Connect the phone to your computer with a reliable USB cable.
5. On the phone screen prompt, select **"Always allow from this computer"** and tap **Allow**.
6. Verify connection in PowerShell:
   ```powershell
   npm run android:devices
   # Or directly: adb devices -l
   ```
   The device state must say `device` (not `unauthorized` or `offline`).

---

### 3.2 Method A: Local USB Development Build (Fastest & Recommended)

This workflow compiles the native app locally, installs it via ADB, and routes Metro bundler traffic over the USB cable using **port reversal** (bypassing all Wi-Fi router isolation and Windows firewall blocks).

#### Step-by-Step Commands:

**Terminal 1 — Port Reversal & Metro Bundler:**

```powershell
# 1. Reverse port 8081 so the phone reaches Metro over USB
npm run android:reverse

# 2. Start Metro bundler in dev-client mode
npm run start:dev
```

**Terminal 2 — Build & Install on Device:**

```powershell
# Compile and install onto the connected physical phone
npm run android:device
```

Once the app opens on your phone:

- It connects automatically to `http://localhost:8081`.
- Grant Location and Sensor permissions when prompted.
- You now have live map rendering, GPS tracking, and instant **Fast Refresh** on code changes!

---

### 3.3 Method B: Standalone Release APK via Gradle (No Metro Required)

If a teammate wants a standalone APK to test outdoors without having their phone connected to a computer:

```powershell
# 1. Generate native android project files
npx expo prebuild -p android

# 2. Compile release APK
cd android
./gradlew assembleRelease
cd ..

# 3. Install directly to connected phone
adb -d install -r android\app\build\outputs\apk\release\app-release.apk

# 4. Launch the app
adb -d shell monkey -p com.sih.bettermaps -c android.intent.category.LAUNCHER 1
```

The APK is generated at `android/app/build/outputs/apk/release/app-release.apk`. It can be shared directly with teammates via Google Drive or messaging apps.

---

### 3.4 Method C: Cloud Development APK via EAS Build

If a teammate does not have Android Studio or the Android SDK installed on their PC:

1. Install EAS CLI and log in:
   ```bash
   npm install -g eas-cli
   eas login
   ```
2. Trigger an Android development build in the Expo cloud:
   ```bash
   eas build --profile development --platform android
   ```
3. When the build finishes, scan the QR code printed in the terminal to download and install the APK directly on your phone.
4. Start Metro on your development machine using tunnel mode:
   ```bash
   npm run start:tunnel
   ```
5. Open the BetterMaps app on your phone and enter your Metro URL.

---

## 4. In-App Features & Validation Checklist

### 4.1 Live Navigation Mode

- Tap the **Destination Search Bar** at the top.
- Search for a destination using Google Places Autocomplete, or select the pre-packaged **Simulator Test Route (Connaught Place Loop)**.
- Tap **Start Navigation**:
  - The map tilts to a 3D driving perspective with heading-up rotation.
  - The **Top Maneuver Banner** displays the next turn instruction and distance.
  - The **Bottom HUD** displays remaining distance, time, and ETA.
  - Toggle between 2D and 3D camera views using the floating camera button.

### 4.2 Phase 4 Dataset Replay Harness

BetterMaps includes an offline dataset replay harness for testing dead-reckoning performance without driving on the road:

- In the Diagnostics drawer, toggle **Replay Harness**.
- Select the pre-packaged fixture (`S1_clean_10hz.json` — real UK driving session from the IO-VNBD dataset).
- Simulate GNSS outages by tapping **Cut GNSS**:
  - The positioning engine switches from `native_gnss` to `idr_dead_reckoning`.
  - Compare the live IDR estimate against the ground-truth VBOX reference trajectory in real time!

### 4.3 High-Rate Sensor Recording

- In the Diagnostics drawer, tap **Start Recording**.
- Drive or walk with the phone.
- Tap **Stop Recording**. The session is saved to:
  `/storage/emulated/0/Android/data/com.sih.bettermaps/files/sessions/<sessionId>/`
- Pull recorded sessions to your PC via ADB:
  ```powershell
  adb pull /storage/emulated/0/Android/data/com.sih.bettermaps/files/sessions/<sessionId> ./captured_sessions/
  python scripts/verify_session.py ./captured_sessions/<sessionId>
  ```

---

## 5. Offline ML Research & Training Pipeline (Phase 5)

The Python research package (`research/idr/`) provides an end-to-end reproducible training loop for BetterMaps IDR models.

### 5.1 Python Dependencies

Install required Python scientific packages:

```bash
pip install torch numpy pandas scipy scikit-learn matplotlib pyyaml
```

### 5.2 Training Dataset & Inventory Audit

The project uses the **IO-VNBD** dataset (72 synchronized sessions across 4 drivers). The repository includes the complete categorized dataset and inventory:

- Dataset location: `research/IO-VNBD/Synchronised V abd S datasets/Categorised IOVNB Dataset/`
- Audit inventory: `artifacts/data/session_inventory.csv`

To re-run the full session audit and alignment check:

```bash
python -c "from research.idr.data.loader import IovnbdLoader; loader = IovnbdLoader(); loader.build_inventory('artifacts/data/session_inventory.csv')"
```

### 5.3 Session Splits & Normalization

Generate strict session-level Train / Val / Test partitions (zero cross-session leakage):

```bash
python research/idr/data/split.py
```

Outputs:

- `artifacts/data/train_sessions.txt` (45 sessions, ~19.6 hours)
- `artifacts/data/val_sessions.txt` (12 sessions, ~5.9 hours)
- `artifacts/data/test_sessions.txt` (10 sessions, ~3.5 hours, strictly locked)
- `artifacts/data/normalization.json` (6-channel mean/std fitted strictly on Train)

### 5.4 Running the Master Experiment Suite

Run the full 16-experiment benchmark:

```bash
python research/idr/run_experiments.py
```

This script executes:

1. **Phase 5A**: Trains classical baselines (B0.1 Mean, B0.2 Persistence, B0.3 Ridge) and neural baselines (B1 Shallow MLP, B2 Tiny Causal TCN, B3 Lightweight GRU).
2. **Phase 5B**: Controlled validation loss sweep over $\lambda_\omega \in \{0.1, 0.25, 0.5, 1.0, 2.0, 4.0\}$ to select the optimal velocity-yaw trade-off ($\lambda_\omega^* = 0.5$).
3. **Phase 5C**: One-time evaluation of the frozen winning model on the locked test set.
4. **Phase 5D**: Kinematic dead-reckoning trajectory integration across synthetic outages (5s, 10s, 20s, 30s, 60s).
5. **Phase 5E**: Heteroscedastic Gaussian uncertainty head training with variance clamping.
6. **Phase 5F**: 50 Hz resampled benchmark vs. native 10 Hz edge compute load.

Results are automatically saved to `artifacts/experiment_registry.csv` and `artifacts/data/outage_evaluation_summary.csv`.

---

## 6. Guidelines for AI Agents & Teammates

### 6.1 Expo SDK 57 Rules

- **Always adhere to Expo v57.0.0 documentation**: [https://docs.expo.dev/versions/v57.0.0/](https://docs.expo.dev/versions/v57.0.0/).
- Do not import deprecated Expo modules.
- Use `npx expo prebuild` when adding or modifying native plugins in `app.json`.

### 6.2 Safe Git Operations on Windows

- **OneDrive / File Lock Warning**: When working in a directory synced by OneDrive or during heavy file writes in VS Code, Git index corruption (`fatal: .git/index: index file smaller than expected`) can occasionally occur if `.git/index` is truncated to 0 bytes.
- **Safe Index Repair Protocol**:

  ```powershell
  # Check if index is 0 bytes
  Get-Item .git/index

  # Safe repair without losing any working-tree changes:
  Remove-Item -Path .git/index -Force
  git reset
  git status
  ```

- **Image Policy**: Per user instructions, never commit or push images (`*.png`, `*.jpg`, screenshots, plots) to the Git repository, except for the base application icons in `assets/*.png`.

### 6.3 Research Integrity Rules

- **No Data Leakage**: Slicing or splitting within the same driving session across train and test sets is strictly forbidden. Splits must remain 100% session-level.
- **Test-Set Locking**: The held-out test set (`artifacts/data/test_sessions.txt`) must never be used for hyperparameter tuning, model architecture selection, or loss weight selection.
- **Trajectory Outages**: Trajectory integrators must be initialized at $t_0$ from the reference state and thereafter integrated strictly from model predictions without intermediate re-anchoring.

---

## 7. Troubleshooting Common Issues

### Issue 1: `adb devices` shows `unauthorized`

- **Fix**: Unlock your phone, disconnect and reconnect the USB cable, and tap **Allow** on the "Allow USB debugging?" prompt.

### Issue 2: Blank Google Maps tiles (grey grid)

- **Fix**: Verify your Google Maps API key in `.env`. Ensure that the **Maps SDK for Android** is enabled in your Google Cloud Console and that your package name (`com.sih.bettermaps`) and debug SHA-1 (`5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`) are added to the key restrictions. Run `npx expo prebuild -p android` to sync the manifest.

### Issue 3: Gradle build fails with `JAVA_HOME` or Java version error

- **Fix**: BetterMaps requires JDK 17. Verify `java -version` returns `17.x`. In Android Studio, check **Settings -> Build, Execution, Deployment -> Build Tools -> Gradle -> Gradle JDK** and ensure it is set to JDK 17.

### Issue 4: Metro bundler shows cached bundle error

- **Fix**: Clear Metro cache and restart:
  ```bash
  npx expo start -c
  ```

---

_For detailed scientific findings and model benchmarks, refer to [`artifacts/reports/IDR_TRAINING_REPORT.md`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/artifacts/reports/IDR_TRAINING_REPORT.md) and [`docs/DATASET_GUIDE.md`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/docs/DATASET_GUIDE.md)._
