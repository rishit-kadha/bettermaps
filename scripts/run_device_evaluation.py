#!/usr/bin/env python3
"""
run_device_evaluation.py

Automated Physical Device Evaluation Harness for BetterMaps IDR Replay.
Executes the locked IO-VNBD test split on real connected Android hardware (OnePlus Nord CE4).
Captures screenshots at all milestone events and aggregates navigation & runtime statistics.
"""

import os
import sys
import time
import json
import uuid
import glob
import subprocess
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
import csv

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADB_PATH = r"C:\Users\rkadh\AppData\Local\Android\Sdk\platform-tools\adb.exe"
DEVICE_SERIAL = "d988dd17"
FIXTURES_DIR = os.path.join(REPO_ROOT, "assets", "datasets", "test_fixtures")
OUTPUT_BASE = os.path.join(REPO_ROOT, "artifacts", "device_evaluation")
SCREENSHOTS_DIR = os.path.join(OUTPUT_BASE, "screenshots")
RESULTS_CSV = os.path.join(OUTPUT_BASE, "device_evaluation_results.csv")
SUMMARY_CSV = os.path.join(OUTPUT_BASE, "device_evaluation_summary.csv")
MANIFEST_JSON = os.path.join(OUTPUT_BASE, "device_evaluation_manifest.json")
LOG_TXT = os.path.join(OUTPUT_BASE, "device_evaluation_log.txt")

PORT = 8088

# Thread-safe Command Queue & Response Registry
pending_command = None
pending_event = threading.Event()
command_response = None
lock = threading.Lock()

def log(msg: str):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    os.makedirs(OUTPUT_BASE, exist_ok=True)
    with open(LOG_TXT, "a", encoding="utf-8") as f:
        f.write(line + "\n")

class BridgeRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # Suppress standard console spam

    def do_GET(self):
        global pending_command
        if self.path == "/poll":
            with lock:
                if pending_command is not None:
                    data = json.dumps(pending_command).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
            self.send_response(204)
            self.end_headers()
            return

        if self.path.startswith("/fixture"):
            # e.g. /fixture?session=M
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            session_id = qs.get("session", [""])[0]
            fixture_file = os.path.join(FIXTURES_DIR, f"iovnbd_{session_id}.json")
            if os.path.exists(fixture_file):
                with open(fixture_file, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                return
            else:
                self.send_response(404)
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
        with open(out_path, "wb") as f:
            f.write(proc.stdout)
        return True
    else:
        log(f"WARNING: Screencap failed or small ({len(proc.stdout)} bytes)")
        return False

def send_command(action: str, params: dict = None, timeout: float = 10.0):
    global pending_command, command_response
    cmd_id = str(uuid.uuid4())
    cmd = {"id": cmd_id, "action": action}
    if params:
        cmd.update(params)

    with lock:
        command_response = None
        pending_event.clear()
        pending_command = cmd

    # Wait for phone to poll and respond
    ok = pending_event.wait(timeout)
    if ok:
        with lock:
            return command_response
    else:
        with lock:
            pending_command = None
        log(f"ERROR: Command {action} timed out after {timeout}s")
        return None

def start_server():
    HTTPServer.allow_reuse_address = True
    server = HTTPServer(("127.0.0.1", PORT), BridgeRequestHandler)
    th = threading.Thread(target=server.serve_forever, daemon=True)
    th.start()
    return server

def setup_adb_reverse():
    log("Configuring ADB reverse port forwarding...")
    r1 = run_adb(["reverse", "tcp:8081", "tcp:8081"])
    r2 = run_adb(["reverse", "tcp:8088", "tcp:8088"])
    log(f"ADB reverse 8081: {r1.returncode}, 8088: {r2.returncode}")

def wait_for_phone_connection(max_wait=30):
    log("Waiting for phone bridge connection on port 8088...")
    t0 = time.time()
    while time.time() - t0 < max_wait:
        res = send_command("GET_STATUS", timeout=1.5)
        if res is not None:
            log("Phone bridge connected successfully!")
            return True
        time.sleep(1.0)
    log("ERROR: Phone failed to connect to bridge within timeout.")
    return False

def main():
    os.makedirs(OUTPUT_BASE, exist_ok=True)
    os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

    setup_adb_reverse()
    server = start_server()
    log(f"Local dev bridge server listening on http://127.0.0.1:{PORT}")

    if not wait_for_phone_connection():
        log("Cannot proceed without phone connection.")
        sys.exit(1)

    # Read locked test sessions
    test_sessions_file = os.path.join(REPO_ROOT, "artifacts", "data", "test_sessions.txt")
    with open(test_sessions_file, "r") as f:
        test_sessions = [l.strip() for l in f if l.strip()]

    log(f"Loaded {len(test_sessions)} locked test sessions: {test_sessions}")

    # Read manifest to check session sample counts
    fixtures_manifest_file = os.path.join(FIXTURES_DIR, "manifest.json")
    with open(fixtures_manifest_file, "r") as f:
        fixtures_manifest = json.load(f)

    # Evaluation Matrix:
    # We will test all sessions across valid outage durations.
    # Primary model: B2_TCN ("tcn")
    # Comparison baseline: Kinematic ("kinematic") on representative session S2
    runs = []

    for s_id in test_sessions:
        info = fixtures_manifest.get(s_id, {})
        duration_sec = info.get("duration_sec", 0)

        # Determine valid durations based on session length
        if duration_sec >= 110:
            durations = [5, 10, 20, 30, 60]
        elif duration_sec >= 80:
            durations = [5, 10, 20, 30]
        elif duration_sec >= 50:
            durations = [5, 10, 20]
        elif duration_sec >= 40:
            durations = [5, 10]
        else:
            durations = [] # Flag as duration limitation (< 20s)

        if not durations:
            runs.append({
                "session": s_id,
                "model": "tcn",
                "duration": None,
                "status": "SKIPPED_DURATION_LIMITATION",
                "notes": f"Session duration ({duration_sec}s) < 20s pre-outage anchor"
            })
            continue

        for dur in durations:
            runs.append({
                "session": s_id,
                "model": "tcn",
                "duration": dur,
                "status": "PENDING"
            })

    # Add baseline comparison runs for S2 (representative highway/urban session)
    for dur in [5, 10, 20, 30, 60]:
        runs.append({
            "session": "S2",
            "model": "kinematic",
            "duration": dur,
            "status": "PENDING",
            "notes": "Classical Kinematic Baseline Comparison"
        })

    log(f"Total planned evaluation runs: {len(runs)}")

    results_data = []
    manifest_records = {}

    for i, run in enumerate(runs):
        s_id = run["session"]
        model = run["model"]
        dur = run["duration"]

        if run.get("status") == "SKIPPED_DURATION_LIMITATION":
            log(f"[{i+1}/{len(runs)}] Session {s_id}: SKIPPED (duration limitation)")
            results_data.append({
                "run_index": i + 1,
                "session_id": s_id,
                "model_backend": model,
                "outage_duration_sec": "N/A",
                "status": "SKIPPED_DURATION_LIMITATION",
                "gnss_delivered_outage": 0,
                "outage_valid": True,
                "mean_error_m": "N/A",
                "outage_max_error_m": "N/A",
                "notes": run.get("notes")
            })
            continue

        log(f"============================================================")
        log(f"[{i+1}/{len(runs)}] RUN: Session={s_id}, Model={model}, Outage={dur}s")
        log(f"============================================================")

        run_tag = f"{s_id}_{model}_{dur}s"
        run_shots_dir = os.path.join(SCREENSHOTS_DIR, s_id, f"{model}_{dur}s")
        os.makedirs(run_shots_dir, exist_ok=True)

        info = fixtures_manifest.get(s_id, {})
        duration_sec = info.get("duration_sec", 119.9)

        # 1. Load Fixture
        res = send_command("LOAD_FIXTURE", {"session": s_id}, timeout=10.0)
        if not res or res.get("status") != "loaded":
            log(f"ERROR: Failed to load fixture for {s_id}")
            continue

        # 2. Configure Run
        outage_start = 20.0 # Standard 20s pre-outage anchor
        speed = 5.0 # 5x virtual speed

        send_command("SET_CONFIG", {
            "mode": "R3_DROP_RECOVERY",
            "speed": speed,
            "outageStartSec": outage_start,
            "outageDurationSec": float(dur),
            "modelBackend": model
        })

        # 3. Reset
        send_command("RESET")
        time.sleep(0.5)

        # Capture Milestone 01: Before Play (t = 0)
        shot_01 = os.path.join(run_shots_dir, "01_before.png")
        take_screenshot(shot_01)
        log(f"  Captured Milestone 01: Before ({shot_01})")

        # 4. Start Playback
        t_wall_start = time.time()
        send_command("PLAY")

        # Pacing: at 5x speed:
        v_pre = min(18.0, duration_sec * 0.3)
        v_mid = 20.0 + dur / 2.0
        v_end = min(duration_sec - 0.5, 19.5 + dur)
        v_rec = min(duration_sec - 0.5, 20.0 + dur + 3.0)
        v_fin = min(duration_sec - 0.5, 20.0 + dur + 12.0)

        t_pre = v_pre / speed
        t_mid = v_mid / speed
        t_end = v_end / speed
        t_rec = v_rec / speed
        t_fin = v_fin / speed

        # Sleep to Pre-outage
        now = time.time() - t_wall_start
        if t_pre > now:
            time.sleep(t_pre - now)
        shot_02 = os.path.join(run_shots_dir, "02_pre_outage.png")
        take_screenshot(shot_02)
        log(f"  Captured Milestone 02: Pre-Outage ({shot_02})")

        # Sleep to Mid-outage
        now = time.time() - t_wall_start
        if t_mid > now:
            time.sleep(t_mid - now)
        shot_03 = os.path.join(run_shots_dir, "03_during_outage.png")
        take_screenshot(shot_03)
        log(f"  Captured Milestone 03: During Outage ({shot_03})")

        # Sleep to Outage End
        now = time.time() - t_wall_start
        if t_end > now:
            time.sleep(t_end - now)
        shot_04 = os.path.join(run_shots_dir, "04_end_outage.png")
        take_screenshot(shot_04)
        log(f"  Captured Milestone 04: End Outage ({shot_04})")

        # Sleep to Recovery
        now = time.time() - t_wall_start
        if t_rec > now:
            time.sleep(t_rec - now)
        shot_05 = os.path.join(run_shots_dir, "05_recovery.png")
        take_screenshot(shot_05)
        log(f"  Captured Milestone 05: Recovery ({shot_05})")

        # Sleep to Final
        now = time.time() - t_wall_start
        if t_fin > now:
            time.sleep(t_fin - now)
        shot_06 = os.path.join(run_shots_dir, "06_final.png")
        take_screenshot(shot_06)
        log(f"  Captured Milestone 06: Final ({shot_06})")

        # Pause and retrieve full report
        send_command("PAUSE")
        status_res = send_command("GET_STATUS")
        report = status_res.get("report", {}) if status_res else {}

        # Zero leakage check
        gnss_during_outage = report.get("gnssDeliveredDuringOutage", 0)
        outage_valid = (gnss_during_outage == 0)
        if not outage_valid:
            log(f"  CRITICAL FAILURE: GNSS leaked during outage! Count={gnss_during_outage}")

        log(f"  Run Results: Mean={report.get('meanErrorMeters')}m, OutageMax={report.get('outageMaxErrorMeters')}m, OutageMean={report.get('outageMeanErrorMeters')}m, PostRec={report.get('postRecoveryErrorMeters')}m, Leakage={gnss_during_outage}")

        record = {
            "run_index": i + 1,
            "session_id": s_id,
            "model_backend": model,
            "outage_duration_sec": dur,
            "status": "COMPLETED" if outage_valid else "LEAKAGE_FAIL",
            "gnss_delivered_before": report.get("gnssDeliveredBeforeOutage", 0),
            "gnss_delivered_outage": gnss_during_outage,
            "gnss_delivered_after": report.get("gnssDeliveredAfterOutage", 0),
            "outage_valid": outage_valid,
            "overall_mean_error_m": report.get("meanErrorMeters", 0),
            "overall_median_error_m": report.get("medianErrorMeters", 0),
            "overall_p90_error_m": report.get("p90ErrorMeters", 0),
            "overall_max_error_m": report.get("maxErrorMeters", 0),
            "outage_mean_error_m": report.get("outageMeanErrorMeters", 0),
            "outage_median_error_m": report.get("outageMedianErrorMeters", 0),
            "outage_p90_error_m": report.get("outageP90ErrorMeters", 0),
            "outage_max_error_m": report.get("outageMaxErrorMeters", 0),
            "post_recovery_mean_error_m": report.get("postRecoveryErrorMeters", 0),
            "milestone_5s_err_m": report.get("milestoneErrors", {}).get("at5s"),
            "milestone_10s_err_m": report.get("milestoneErrors", {}).get("at10s"),
            "milestone_20s_err_m": report.get("milestoneErrors", {}).get("at20s"),
            "milestone_30s_err_m": report.get("milestoneErrors", {}).get("at30s"),
            "milestone_60s_err_m": report.get("milestoneErrors", {}).get("at60s"),
            "notes": run.get("notes", "")
        }
        results_data.append(record)

        # Save intermediate CSV
        df = pd.DataFrame(results_data)
        df.to_csv(RESULTS_CSV, index=False)

        manifest_records[run_tag] = {
            "session": s_id,
            "model": model,
            "duration": dur,
            "report": report,
            "screenshots": {
                "01_before": shot_01,
                "02_pre_outage": shot_02,
                "03_during_outage": shot_03,
                "04_end_outage": shot_04,
                "05_recovery": shot_05,
                "06_final": shot_06
            }
        }
        with open(MANIFEST_JSON, "w", encoding="utf-8") as f:
            json.dump(manifest_records, f, indent=2)

    # Compute Aggregate Summary Table
    df_completed = pd.DataFrame([r for r in results_data if r.get("status") == "COMPLETED"])
    if not df_completed.empty:
        summary = df_completed.groupby(["model_backend", "outage_duration_sec"]).agg(
            sessions=("session_id", "count"),
            outage_mean_err_m=("outage_mean_error_m", "mean"),
            outage_median_err_m=("outage_median_error_m", "median"),
            outage_p90_err_m=("outage_p90_error_m", "mean"),
            outage_max_err_m=("outage_max_error_m", "max"),
            post_rec_mean_err_m=("post_recovery_mean_error_m", "mean")
        ).reset_index()
        summary.to_csv(SUMMARY_CSV, index=False)
        log(f"\nEvaluation Complete! Summary:\n{summary.to_string()}")

    log("Physical device evaluation execution finished.")

if __name__ == "__main__":
    main()
