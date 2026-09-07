# Standalone Android Build Guide

This document explains how to build and install a standalone release APK for BetterMaps that runs without the Metro development server.

## Overview

BetterMaps uses Expo SDK 57 with React Native 0.86.3. The release build embeds:
- Hermes bytecode (`assets/index.android.bundle`)
- ONNX native libraries (`libonnxruntime.so`, `libonnxruntimejsi.so`)
- Offline road network data (Coventry, embedded in the JS bundle via `require()`)
- B3_GRU and SIH_GRU model weights (embedded in the JS bundle)

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 24+ | |
| npm | 10+ | |
| JDK | 17+ | `JAVA_HOME` must be set |
| Android SDK | API 35+ | `ANDROID_HOME` / `ANDROID_SDK_ROOT` must be set |
| Gradle | 9.3.1 | Managed by `gradlew` wrapper |

## Build Steps

### 1. Install dependencies

```bash
npm install
# patch-package runs automatically via postinstall hook
```

### 2. Build the release APK

```bash
cd android
.\gradlew.bat app:assembleRelease "-PreactNativeArchitectures=arm64-v8a,x86_64"
```

Expected output:
```
BUILD SUCCESSFUL in 3m 8s
623 actionable tasks: 357 executed, 266 up-to-date
```

APK location: `android/app/build/outputs/apk/release/app-release.apk`

### 3. Install on device/emulator

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

### 4. Clear any dev server tunnels

```bash
adb reverse --remove-all
```

### 5. Launch the app

```bash
adb shell am start -n com.sih.bettermaps/.MainActivity
```

## Build Architecture

```
Release APK
├── assets/
│   ├── index.android.bundle     # Hermes bytecode (5MB, all JS + assets inlined)
│   ├── app.config               # Expo configuration
│   └── dexopt/                  # ART optimization profiles
├── lib/
│   ├── arm64-v8a/
│   │   ├── libonnxruntime.so    # ONNX Runtime native engine
│   │   ├── libonnxruntimejsi.so # ONNX Runtime JSI bridge
│   │   ├── libhermesvm.so       # Hermes JS engine
│   │   ├── libreactnative.so    # React Native core
│   │   └── ...
│   └── x86_64/
│       └── ...                  # Same libraries for x86_64 emulator
└── classes*.dex                 # Compiled Java/Kotlin code
```

## Why Only 4 Assets?

ONNX model weights (`.onnx` files) and road network JSON are **NOT** separate asset files — they are inlined into `index.android.bundle` via Metro's `require()` bundler. This means:

- ONNX model data is encoded as base64 in the JS bundle and decoded at runtime
- Road network JSON is parsed from a bundled module
- No separate file extraction is needed at runtime

## Debug vs Release Builds

| Feature | Debug build (`app-debug.apk`) | Release build (`app-release.apk`) |
|---------|------------------------------|-----------------------------------|
| JS loading | From Metro server (port 8081) | From embedded `index.android.bundle` |
| Metro required | ✅ YES | ❌ NO |
| `expo-dev-client` | Active | Disabled automatically |
| Hermes | Interpreted | Ahead-of-time compiled (bytecode) |
| APK size | Smaller | Larger (includes bundle) |
| Standalone | ❌ NO | ✅ YES |

## Gradle Build Patches

The `patches/` directory contains fixes for Gradle 9 incompatibilities:

### `patches/onnxruntime-react-native+1.24.3.patch`
- **Problem**: `VersionNumber.parse()` was removed in Gradle 9
- **Fix**: Replace with `if (false)` — condition is always false for RN 0.86.3+

### `patches/expo+57.0.19.patch`
- **Problem**: `canBePublished false` (Groovy method call) fails since only Kotlin property assignment is registered
- **Fix**: Change to `canBePublished = false` (property assignment)

### `patches/expo-modules-core+57.0.15.patch`
- **Problem 1**: No `canBePublished(Boolean)` method on `ExpoModuleExtension` for Groovy DSL
- **Fix 1**: Add `fun canBePublished(value: Boolean)` method
- **Problem 2**: `project.components.getByName("release")` crashes when release component not registered
- **Fix 2**: Add null guard using `findByName("release")` with early return

## Metro Node.js Module Shims

Metro does not support Node.js built-ins (`fs`, `path`). The following shim strategy is used:

- **`src/shims/emptyNodeModule.js`**: Returns `{}` (empty shim)
- **`metro.config.js`**: `extraNodeModules: { fs: emptyShim, path: emptyShim }`
- **Source files**: All `require("fs")` calls replaced with `(globalThis as any).require("fs")`
  - This prevents Metro from statically resolving the require
  - At runtime in Node.js (tests), `globalThis.require` exists
  - At runtime in Hermes (Android), `globalThis.require` is undefined → safe null check

## Signing

The release APK is signed with the **debug keystore** by default (`android/app/build.gradle` → `signingConfig signingConfigs.debug`). This is sufficient for direct ADB installation. For Play Store distribution, configure a release keystore.

## Dev Server Workflow (Development)

The dev build workflow still works:

```bash
npm run start:dev   # Start Metro + Expo dev client
# or
npm run start       # Standard Expo start
```

Dev builds load JS from Metro and include the Expo dev client overlay. This workflow is NOT affected by the release patches.
