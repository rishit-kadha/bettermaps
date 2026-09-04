#!/usr/bin/env node

/**
 * adb-cli.js
 *
 * Cross-shell ADB helper for BetterMaps.
 * Works seamlessly in Git Bash, PowerShell, and Command Prompt.
 * Automatically resolves the Android SDK platform-tools path from %LOCALAPPDATA%
 * and correctly disambiguates between connected physical phones and emulators.
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

function getAdbPath() {
  if (process.env.ADB_PATH && fs.existsSync(process.env.ADB_PATH)) {
    return process.env.ADB_PATH;
  }

  // 1. Check Windows LOCALAPPDATA
  if (process.env.LOCALAPPDATA) {
    const candidate = path.join(
      process.env.LOCALAPPDATA,
      "Android",
      "Sdk",
      "platform-tools",
      "adb.exe",
    );
    if (fs.existsSync(candidate)) return candidate;
  }

  // 2. Check ANDROID_HOME / ANDROID_SDK_ROOT
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdkRoot) {
    const candidate = path.join(
      sdkRoot,
      "platform-tools",
      os.platform() === "win32" ? "adb.exe" : "adb",
    );
    if (fs.existsSync(candidate)) return candidate;
  }

  // 3. Check User home standard paths
  const home = os.homedir();
  const standardPaths = [
    path.join(
      home,
      "AppData",
      "Local",
      "Android",
      "Sdk",
      "platform-tools",
      "adb.exe",
    ),
    path.join(home, "Library", "Android", "sdk", "platform-tools", "adb"),
    path.join(home, "Android", "Sdk", "platform-tools", "adb"),
  ];
  for (const p of standardPaths) {
    if (fs.existsSync(p)) return p;
  }

  return "adb";
}

function getDevices(adb) {
  try {
    const output = execSync(`"${adb}" devices -l`, { encoding: "utf8" });
    const lines = output.trim().split("\n").slice(1);
    const devices = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2 && parts[1] === "device") {
        const id = parts[0];
        const isEmulator = id.startsWith("emulator-");
        const modelMatch = trimmed.match(/model:([^\s]+)/);
        const productMatch = trimmed.match(/product:([^\s]+)/);
        devices.push({
          id,
          isEmulator,
          model: modelMatch ? modelMatch[1] : isEmulator ? "Emulator" : "Phone",
          product: productMatch ? productMatch[1] : "",
          raw: trimmed,
        });
      }
    }
    return devices;
  } catch (err) {
    console.error(`❌ Failed to execute "${adb} devices -l":`, err.message);
    return [];
  }
}

function ensureJdk17Environment() {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const jdk17 = path.join(localAppData, "jdk17", "jdk-17.0.12+7");
    if (fs.existsSync(jdk17) && !process.env.JAVA_HOME) {
      process.env.JAVA_HOME = jdk17;
      process.env.PATH = `${path.join(jdk17, "bin")}${path.delimiter}${process.env.PATH}`;
    }
  }
  if (localAppData && !process.env.ANDROID_HOME) {
    const sdk = path.join(localAppData, "Android", "Sdk");
    if (fs.existsSync(sdk)) {
      process.env.ANDROID_HOME = sdk;
    }
  }
}

const action = process.argv[2] || "help";
const adb = getAdbPath();

switch (action) {
  case "devices": {
    console.log(`Using ADB: ${adb}`);
    const devices = getDevices(adb);
    if (devices.length === 0) {
      console.log("No devices or emulators attached.");
    } else {
      console.log(`Found ${devices.length} attached device(s):`);
      devices.forEach((d) => {
        const type = d.isEmulator ? "🤖 [Emulator]" : "📱 [Physical Phone]";
        console.log(
          `  - ${d.id.padEnd(16)} ${type.padEnd(20)} Model: ${d.model} (${d.product})`,
        );
      });
    }
    break;
  }

  case "reverse": {
    const devices = getDevices(adb);
    if (devices.length === 0) {
      console.error(
        "❌ No attached Android devices found. Connect your phone via USB or start the emulator.",
      );
      process.exit(1);
    }

    // Prioritize physical phones
    const physical = devices.filter((d) => !d.isEmulator);
    const targets = physical.length > 0 ? physical : devices;

    for (const target of targets) {
      try {
        execSync(`"${adb}" -s ${target.id} reverse tcp:8081 tcp:8081`, {
          stdio: "inherit",
        });
        console.log(
          `✅ Reversed Metro port 8081 on ${target.isEmulator ? "emulator" : "physical phone"} [${target.id}] (${target.model})`,
        );
      } catch (err) {
        console.error(
          `❌ Failed to reverse port on [${target.id}]:`,
          err.message,
        );
      }
    }
    break;
  }

  case "device": {
    const devices = getDevices(adb);
    const physical = devices.filter((d) => !d.isEmulator);

    if (physical.length === 0) {
      console.error(
        '❌ No physical Android phone detected in "adb devices -l".',
      );
      console.error("Please check:");
      console.error("  1. USB cable is plugged in");
      console.error("  2. USB Debugging is turned ON in Developer Options");
      console.error(
        "  3. Authorize computer prompt was accepted on the phone screen",
      );
      process.exit(1);
    }

    const phone = physical[0];
    console.log(
      `📱 Targeting physical phone: ${phone.id} (${phone.model}, ${phone.product})`,
    );

    const apkPath = path.resolve(
      __dirname,
      "..",
      "android",
      "app",
      "build",
      "outputs",
      "apk",
      "debug",
      "app-debug.apk",
    );

    // If APK does not exist or user specified --build, build it with Gradle
    const forceBuild =
      process.argv.includes("--build") || !fs.existsSync(apkPath);
    if (forceBuild) {
      console.log("📦 Building ARM64 Debug APK for physical device...");
      ensureJdk17Environment();
      const gradlew = os.platform() === "win32" ? "gradlew.bat" : "./gradlew";
      const androidDir = path.resolve(__dirname, "..", "android");
      const res = spawnSync(
        gradlew,
        ["app:assembleDebug", "-PreactNativeArchitectures=arm64-v8a"],
        {
          cwd: androidDir,
          stdio: "inherit",
          shell: true,
        },
      );
      if (res.status !== 0) {
        console.error("❌ Gradle APK build failed.");
        process.exit(res.status || 1);
      }
    }

    console.log(`🚀 Installing BetterMaps onto ${phone.id}...`);
    try {
      execSync(`"${adb}" -s ${phone.id} install -r "${apkPath}"`, {
        stdio: "inherit",
      });
      console.log(`✅ BetterMaps APK installed successfully.`);
    } catch (err) {
      console.error(`❌ Failed to install APK on ${phone.id}:`, err.message);
      process.exit(1);
    }

    // Grant location permissions
    try {
      execSync(
        `"${adb}" -s ${phone.id} shell pm grant com.sih.bettermaps android.permission.ACCESS_FINE_LOCATION`,
        { stdio: "ignore" },
      );
      execSync(
        `"${adb}" -s ${phone.id} shell pm grant com.sih.bettermaps android.permission.ACCESS_COARSE_LOCATION`,
        { stdio: "ignore" },
      );
      console.log(`✅ Location permissions granted.`);
    } catch {}

    // Reverse port 8081 over USB
    try {
      execSync(`"${adb}" -s ${phone.id} reverse tcp:8081 tcp:8081`, {
        stdio: "ignore",
      });
      console.log(`✅ Port 8081 reversed for USB Metro connection.`);
    } catch {}

    // Launch the app
    console.log(`📲 Launching BetterMaps on ${phone.model}...`);
    try {
      execSync(
        `"${adb}" -s ${phone.id} shell monkey -p com.sih.bettermaps -c android.intent.category.LAUNCHER 1`,
        { stdio: "ignore" },
      );
      console.log(`✨ BetterMaps is now running on your physical phone!`);
    } catch (err) {
      console.error(`❌ Failed to launch BetterMaps:`, err.message);
    }
    break;
  }

  case "emulator": {
    const devices = getDevices(adb);
    const emulators = devices.filter((d) => d.isEmulator);

    if (emulators.length === 0) {
      console.error(
        "❌ No running Android emulator found. Start your emulator first.",
      );
      process.exit(1);
    }

    const emu = emulators[0];
    console.log(`🤖 Targeting emulator: ${emu.id}`);

    const apkPath = path.resolve(
      __dirname,
      "..",
      "android",
      "app",
      "build",
      "outputs",
      "apk",
      "debug",
      "app-debug.apk",
    );
    if (!fs.existsSync(apkPath)) {
      console.error("❌ Debug APK not found. Please build it first.");
      process.exit(1);
    }

    console.log(`🚀 Installing BetterMaps on emulator ${emu.id}...`);
    execSync(`"${adb}" -s ${emu.id} install -r "${apkPath}"`, {
      stdio: "inherit",
    });
    execSync(
      `"${adb}" -s ${emu.id} shell pm grant com.sih.bettermaps android.permission.ACCESS_FINE_LOCATION`,
      { stdio: "ignore" },
    );
    execSync(
      `"${adb}" -s ${emu.id} shell pm grant com.sih.bettermaps android.permission.ACCESS_COARSE_LOCATION`,
      { stdio: "ignore" },
    );
    execSync(
      `"${adb}" -s ${emu.id} shell monkey -p com.sih.bettermaps -c android.intent.category.LAUNCHER 1`,
      { stdio: "ignore" },
    );
    console.log(`✨ BetterMaps launched on emulator!`);
    break;
  }

  default: {
    console.log("Usage: node scripts/adb-cli.js [command]");
    console.log("Commands:");
    console.log(
      "  devices   - List all attached devices and identify physical vs emulator",
    );
    console.log(
      "  reverse   - Reverse Metro port 8081 specifically on the physical phone",
    );
    console.log(
      "  device    - Install and launch BetterMaps on the physical phone",
    );
    console.log(
      "  emulator  - Install and launch BetterMaps on the Android emulator",
    );
    break;
  }
}
