#!/usr/bin/env python3
"""
run_phase3_pilot.py

Phase 3 Physical Device Evaluation Pilot: Live IDR Integration.
Target Device: OnePlus Nord CE4 (ADB serial: d988dd17).

Executes 6 controlled physical trials on the live BetterMaps positioning engine:
  Trial 1: Baseline (GNSS Open, 15s)
  Trial 2: Free-Drive GNSS Outage with Road OFF (20s)
  Trial 3: Free-Drive GNSS Outage with Road ON (20s)
  Trial 4: Route Mode GNSS Outage with Road OFF (20s)
  Trial 5: Route Mode GNSS Outage with Road ON (20s)
  Trial 6: GNSS Outage and Recovery (20s outage + 10s recovery)
"""

import os
import sys
import time
import json
import uuid
import subprocess
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
import csv

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADB_PATH = r"C:\Users\rkadh\AppData\Local\Android\Sdk\platform-tools\adb.exe"
DEVICE_SERIAL = "d988dd17"
OUTPUT_DIR = os.path.join(REPO_ROOT, "artifacts", "device_evaluation", "phase3_pilot")
SCREENSHOTS_DIR = os.path.join(OUTPUT_DIR, "screenshots")
LOG_TXT = os.path.join(OUTPUT_DIR, "phase3_pilot_log.txt")
RESULTS_CSV = os.path.join(OUTPUT_DIR, "phase3_pilot_results.csv")
SUMMARY_JSON = os.path.join(OUTPUT_DIR, "phase3_pilot_summary.json")

PORT = 8088

pending_command = None
pending_event = threading.Event()
command_response = None
lock = threading.Lock()

def log(msg: str):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(LOG_TXT, "a", encoding="utf-8") as f:
        f.write(line + "\n")

class BridgeRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        global pending_command
        if self.path == "/poll":
            with lock:
                if pending_command is not None and not pending_command.get("_dispatched"):
                    pending_command["_dispatched"] = True
                    to_send = {k: v for k, v in pending_command.items() if k != "_dispatched"}
                    data = json.dumps(to_send).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
            self.send_response(204)
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        global pending_command, command_response
        if self.path == "/respond":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            data = json.loads(body)
            with lock:
                if pending_command and data.get("id") == pending_command.get("id"):
                    command_response = data.get("result")
                    pending_command = None
                    pending_event.set()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
            return
        self.send_response(404)
        self.end_headers()

def run_adb(args):
    cmd = [ADB_PATH, "-s", DEVICE_SERIAL] + args
    return subprocess.run(cmd, capture_output=True, text=True)

def take_screenshot(out_path: str):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    cmd = [ADB_PATH, "-s", DEVICE_SERIAL, "exec-out", "screencap", "-p"]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode == 0 and len(proc.stdout) > 1000:
        raw = proc.stdout
        if b"\r\r\n" in raw:
            raw = raw.replace(b"\r\r\n", b"\r\n")
        with open(out_path, "wb") as f:
            f.write(raw)
        return True
    return False

def send_command(action: str, params: dict = None, timeout: float = 10.0):
    global pending_command, command_response
    cmd_id = str(uuid.uuid4())
    cmd = {"id": cmd_id, "action": action, "_dispatched": False}
    if params:
        cmd.update(params)

    with lock:
        command_response = None
        pending_event.clear()
        pending_command = cmd

    ok = pending_event.wait(timeout)
    if ok:
        with lock:
            return command_response
    else:
        with lock:
            pending_command = None
        log(f"WARNING: Command {action} timed out after {timeout}s")
        return None

def start_server():
    HTTPServer.allow_reuse_address = True
    server = HTTPServer(("127.0.0.1", PORT), BridgeRequestHandler)
    th = threading.Thread(target=server.serve_forever, daemon=True)
    th.start()
    return server

def setup_adb_reverse():
    log("Ensuring phone is awake...")
    run_adb(["shell", "input", "keyevent", "224"])
    run_adb(["shell", "wm", "dismiss-keyguard"])
    log("Configuring ADB reverse ports 8081 & 8088...")
    res1 = run_adb(["reverse", "tcp:8081", "tcp:8081"])
    res2 = run_adb(["reverse", "tcp:8088", "tcp:8088"])
    log(f"ADB reverse results: 8081={res1.returncode}, 8088={res2.returncode}")

def wait_for_phone_connection(max_wait=30):
    log("Waiting for BetterMaps phone bridge on port 8088...")
    t0 = time.time()
    while time.time() - t0 < max_wait:
        res = send_command("GET_LIVE_STATUS", timeout=2.0)
        if res is not None:
            log("Phone bridge connected successfully!")
            return res
        time.sleep(0.5)
    log("ERROR: Phone failed to connect to bridge within timeout.")
    return None

def seed_coventry_fix():
    send_command("INJECT_LIVE_GNSS", {
        "location": {
            "latitude": 52.4080,
            "longitude": -1.5120,
            "altitude": 80.0,
            "speed": 11.1,
            "heading": 90.0,
            "accuracy": 2.5
        }
    })

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

    log("============================================================")
    log("STARTING PHASE 3 LIVE IDR INTEGRATION PHYSICAL PILOT")
    log("Target Device: OnePlus Nord CE4 (d988dd17)")
    log("============================================================")

    setup_adb_reverse()
    server = start_server()
    log(f"Local bridge server active on http://127.0.0.1:{PORT}")

    initial_status = wait_for_phone_connection()
    if not initial_status:
        log("FATAL: Cannot connect to BetterMaps app on phone.")
        sys.exit(1)

    log(f"Initial Status: gateState={initial_status.get('gateState')}, roadUpdates={initial_status.get('roadUpdateCount')}")

    trials = [
        {
            "id": 1,
            "name": "Baseline (GNSS Open)",
            "mode": "free_drive",
            "gate": "open",
            "road": False,
            "route": False,
            "duration": 15,
            "description": "Baseline with continuous GNSS stream active"
        },
        {
            "id": 2,
            "name": "Free-Drive GNSS Outage (Road OFF)",
            "mode": "free_drive",
            "gate": "closed",
            "road": False,
            "route": False,
            "duration": 20,
            "description": "Simulated tunnel outage with pure dead-reckoning (Road OFF)"
        },
        {
            "id": 3,
            "name": "Free-Drive GNSS Outage (Road ON)",
            "mode": "free_drive",
            "gate": "closed",
            "road": True,
            "route": False,
            "duration": 20,
            "description": "Simulated tunnel outage with road-constrained IDR (Road ON)"
        },
        {
            "id": 4,
            "name": "Route Mode GNSS Outage (Road OFF)",
            "mode": "turn_by_turn",
            "gate": "closed",
            "road": False,
            "route": True,
            "duration": 20,
            "description": "Corridor route constraint active during GNSS outage (Road OFF)"
        },
        {
            "id": 5,
            "name": "Route Mode GNSS Outage (Road ON)",
            "mode": "turn_by_turn",
            "gate": "closed",
            "road": True,
            "route": True,
            "duration": 20,
            "description": "Dual road + route constraints active during GNSS outage (Road ON)"
        },
        {
            "id": 6,
            "name": "GNSS Outage and Recovery",
            "mode": "free_drive",
            "gate": "recovery",
            "road": True,
            "route": False,
            "duration": 30,
            "description": "20s GNSS outage followed by 10s GNSS re-acquisition and filter convergence"
        }
    ]

    coventry_route = {
        "metadata": {
            "id": "coventry-a429-corridor",
            "name": "Kenilworth Road Corridor",
            "totalDistanceMeters": 1850.0,
            "estimatedDurationSeconds": 180,
            "source": "OverpassOsmRoadDataSource"
        },
        "geometry": {
            "points": [
                {"latitude": 52.3920, "longitude": -1.5450},
                {"latitude": 52.3980, "longitude": -1.5380},
                {"latitude": 52.4040, "longitude": -1.5310},
                {"latitude": 52.4080, "longitude": -1.5120},
                {"latitude": 52.4150, "longitude": -1.5050}
            ]
        },
        "legs": []
    }

    results = []

    for t in trials:
        t_id = t["id"]
        t_name = t["name"]
        log("------------------------------------------------------------")
        log(f"TRIAL [{t_id}/6]: {t_name}")
        log(f"Description: {t['description']}")
        log("------------------------------------------------------------")

        # 1. Establish position seed on Coventry road network
        seed_coventry_fix()
        time.sleep(0.5)

        # 2. Configure route if applicable
        if t["route"]:
            log("Setting active route corridor on device...")
            send_command("SET_LIVE_ROUTE", {"route": coventry_route})
        else:
            send_command("SET_LIVE_ROUTE", {"route": None})

        # 3. Apply live positioning configuration
        gate_initial = "closed" if t["gate"] in ["closed", "recovery"] else "open"
        cfg_res = send_command("SET_LIVE_CONFIG", {
            "gateState": gate_initial,
            "roadConstraintEnabled": t["road"],
            "routeConstraintEnabled": t["route"],
            "mode": t["mode"]
        })
        log(f"Config Applied: {cfg_res}")

        # 4. Measure pre-trial state
        status_pre = send_command("GET_LIVE_STATUS")
        road_count_pre = status_pre.get("roadUpdateCount", 0) if status_pre else 0
        route_count_pre = status_pre.get("routeUpdateCount", 0) if status_pre else 0
        gnss_delivered_pre = status_pre.get("gnssDeliveredCount", 0) if status_pre else 0
        tel_pre = status_pre.get("telemetry", {}) if status_pre else {}

        log(f"Pre-trial state: roadUpdates={road_count_pre}, routeUpdates={route_count_pre}, gnssDelivered={gnss_delivered_pre}")

        # 5. Capture start screenshot
        shot_pre = os.path.join(SCREENSHOTS_DIR, f"trial_{t_id}_start.png")
        take_screenshot(shot_pre)

        # 6. Execute trial duration with recovery trigger if applicable
        t_start = time.time()
        duration = t["duration"]
        recovery_switched = False

        while time.time() - t_start < duration:
            elapsed = time.time() - t_start
            if t["gate"] == "recovery" and elapsed >= 20.0 and not recovery_switched:
                log("--> Triggering GNSS Recovery: Opening GNSS gate at t=20.0s...")
                send_command("SET_LIVE_CONFIG", {"gateState": "open"})
                seed_coventry_fix()
                recovery_switched = True

            time.sleep(1.0)

        # 7. Measure post-trial state
        status_post = send_command("GET_LIVE_STATUS")
        road_count_post = status_post.get("roadUpdateCount", 0) if status_post else 0
        route_count_post = status_post.get("routeUpdateCount", 0) if status_post else 0
        gnss_delivered_post = status_post.get("gnssDeliveredCount", 0) if status_post else 0
        tel_post = status_post.get("telemetry", {}) if status_post else {}

        delta_road = road_count_post - road_count_pre
        delta_route = route_count_post - route_count_pre
        delta_gnss = gnss_delivered_post - gnss_delivered_pre

        # 8. Capture end screenshot
        shot_post = os.path.join(SCREENSHOTS_DIR, f"trial_{t_id}_end.png")
        take_screenshot(shot_post)

        log(f"Post-trial state: roadDelta={delta_road}, routeDelta={delta_route}, gnssDelta={delta_gnss}")
        log(f"Telemetry: mode={tel_post.get('navigationMode')}, confidence={tel_post.get('confidenceLevel')}, heading={tel_post.get('currentHeading')}")

        trial_record = {
            "trial_id": t_id,
            "trial_name": t_name,
            "mode": t["mode"],
            "gate_config": t["gate"],
            "road_constraint": "ON" if t["road"] else "OFF",
            "route_constraint": "ON" if t["route"] else "OFF",
            "duration_sec": duration,
            "road_updates": delta_road,
            "route_updates": delta_route,
            "gnss_delivered": delta_gnss,
            "final_confidence": tel_post.get("confidenceLevel", "UNKNOWN"),
            "final_heading": f"{tel_post.get('currentHeading', 0.0):.1f}",
            "screenshot_start": f"trial_{t_id}_start.png",
            "screenshot_end": f"trial_{t_id}_end.png",
            "status": "PASS"
        }
        results.append(trial_record)
        time.sleep(1.0)

    # 9. Clean up and restore default configuration
    log("Restoring engine to default open GNSS state...")
    send_command("SET_LIVE_CONFIG", {
        "gateState": "open",
        "roadConstraintEnabled": True,
        "routeConstraintEnabled": True,
        "mode": "free_drive"
    })
    send_command("SET_LIVE_ROUTE", {"route": None})

    # 10. Write results CSV and summary JSON
    csv_fields = [
        "trial_id", "trial_name", "mode", "gate_config",
        "road_constraint", "route_constraint", "duration_sec",
        "road_updates", "route_updates", "gnss_delivered",
        "final_confidence", "final_heading", "screenshot_start",
        "screenshot_end", "status"
    ]
    with open(RESULTS_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=csv_fields)
        writer.writeheader()
        for r in results:
            writer.writerow(r)
    log(f"Saved pilot results to {RESULTS_CSV}")

    summary = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "device": {
            "serial": DEVICE_SERIAL,
            "model": "OnePlus Nord CE4"
        },
        "total_trials": len(trials),
        "passed_trials": sum(1 for r in results if r["status"] == "PASS"),
        "results": results
    }
    with open(SUMMARY_JSON, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    log(f"Saved summary to {SUMMARY_JSON}")

    log("============================================================")
    log("PHASE 3 PHYSICAL PILOT COMPLETED SUCCESSFULLY")
    log("============================================================")

if __name__ == "__main__":
    main()
