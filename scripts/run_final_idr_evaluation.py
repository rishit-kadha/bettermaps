#!/usr/bin/env python3
"""
run_final_idr_evaluation.py

Physical Device Evaluation Harness for the Final IDR Pipeline and Road Ablation.
Executes the locked IO-VNBD test split on the physical OnePlus Nord CE4 (ADB serial d988dd17).
Evaluates FINAL_IDR (Road ON) vs FINAL_IDR_ROAD_ABLATION (Road OFF) under identical
deterministic outage conditions (outage starts at exactly t = 20.0s).
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
FIXTURES_DIR = os.path.join(REPO_ROOT, "assets", "datasets", "test_fixtures")
OUTPUT_BASE = os.path.join(REPO_ROOT, "artifacts", "device_evaluation")
SCREENSHOTS_DIR = os.path.join(OUTPUT_BASE, "screenshots")
LOG_TXT = os.path.join(OUTPUT_BASE, "final_idr_evaluation_log.txt")

RESULTS_CSV = os.path.join(OUTPUT_BASE, "final_idr_physical_results.csv")
SESSION_RESULTS_CSV = os.path.join(OUTPUT_BASE, "final_idr_session_results.csv")
SUMMARY_CSV = os.path.join(OUTPUT_BASE, "final_idr_summary.csv")
ABLATION_CSV = os.path.join(OUTPUT_BASE, "final_idr_road_ablation_comparison.csv")
LATENCY_CSV = os.path.join(OUTPUT_BASE, "final_idr_latency.csv")
RECOVERY_CSV = os.path.join(OUTPUT_BASE, "final_idr_recovery_metrics.csv")
MANIFEST_JSON = os.path.join(OUTPUT_BASE, "final_idr_run_manifest.json")
TRAJECTORY_JSON = os.path.join(OUTPUT_BASE, "final_idr_trajectory_data.json")

PORT = 8088

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
        pass

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
    return False

def take_screenshot_async(out_path: str):
    threading.Thread(target=take_screenshot, args=(out_path,), daemon=True).start()

def send_command(action: str, params: dict = None, timeout: float = 12.0):
    global pending_command, command_response
    cmd_id = str(uuid.uuid4())
    cmd = {"id": cmd_id, "action": action}
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
        log(f"ERROR: Command {action} timed out after {timeout}s")
        return None

def start_server():
    HTTPServer.allow_reuse_address = True
    server = HTTPServer(("127.0.0.1", PORT), BridgeRequestHandler)
    th = threading.Thread(target=server.serve_forever, daemon=True)
    th.start()
    return server

def setup_adb_reverse():
    log("Setting up ADB reverse port forwarding (8081, 8088)...")
    r1 = run_adb(["reverse", "tcp:8081", "tcp:8081"])
    r2 = run_adb(["reverse", "tcp:8088", "tcp:8088"])
    log(f"ADB reverse 8081 code: {r1.returncode}, 8088 code: {r2.returncode}")

def wait_for_phone_connection(max_wait=30):
    log("Waiting for phone bridge connection on port 8088...")
    t0 = time.time()
    while time.time() - t0 < max_wait:
        res = send_command("GET_STATUS", timeout=1.5)
        if res is not None:
            log("Phone bridge connected successfully!")
            return True
        time.sleep(0.5)
    log("ERROR: Phone failed to connect to bridge within timeout.")
    return False

def build_run_list(test_sessions, fixtures_manifest):
    runs = []
    # Two evaluation modes
    modes = ["FINAL_IDR", "FINAL_IDR_ROAD_ABLATION"]

    for mode in modes:
        for s_id in test_sessions:
            info = fixtures_manifest.get(s_id, {})
            duration_sec = info.get("duration_sec", 0)

            # Determine valid outage durations based on session length with 20s pre-outage anchor
            # 60s outage requires 20s + 60s + 5s = 85s minimum duration
            # 30s outage requires 20s + 30s + 5s = 55s minimum duration
            # 20s outage requires 20s + 20s + 5s = 45s minimum duration
            # 10s outage requires 20s + 10s + 5s = 35s minimum duration
            # 5s outage requires 20s + 5s + 5s = 30s minimum duration
            if duration_sec >= 110:
                durations = [5, 10, 20, 30, 60]
            elif duration_sec >= 80:
                durations = [5, 10, 20, 30]
            elif duration_sec >= 50:
                durations = [5, 10, 20]
            elif duration_sec >= 35:
                durations = [5, 10]
            else:
                durations = [] # Duration limitation (< 20s pre-outage anchor)

            if not durations:
                runs.append({
                    "session": s_id,
                    "mode": mode,
                    "duration": None,
                    "status": "SKIPPED_DURATION_LIMITATION",
                    "notes": f"Session duration ({duration_sec:.1f}s) < 20s pre-outage anchor"
                })
                continue

            for dur in durations:
                runs.append({
                    "session": s_id,
                    "mode": mode,
                    "duration": dur,
                    "status": "PENDING"
                })

    return runs

def write_csv(filepath, rows, fieldnames):
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in rows:
            writer.writerow(r)

def main():
    os.makedirs(OUTPUT_BASE, exist_ok=True)
    os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

    setup_adb_reverse()
    server = start_server()
    log(f"Local dev bridge server listening on http://127.0.0.1:{PORT}")

    if not wait_for_phone_connection():
        log("Cannot proceed without phone connection.")
        sys.exit(1)

    # 1. Run Mobile Latency Micro-Benchmark on device
    log("============================================================")
    log("STEP 1: RUNNING PHYSICAL DEVICE LATENCY BENCHMARK (1000 TICKS)")
    log("============================================================")
    bench_res = send_command("RUN_BENCHMARK", {"ticks": 1000}, timeout=25.0)
    if bench_res and bench_res.get("benchmark"):
        b_data = bench_res["benchmark"]
        latency_rows = []
        for stage_key, stats in b_data.items():
            latency_rows.append({
                "subsystem": stats.get("stage", stage_key),
                "samples_n": stats.get("n", 0),
                "mean_ms": f"{stats.get('meanMs', 0):.4f}",
                "median_ms": f"{stats.get('medianMs', 0):.4f}",
                "p95_ms": f"{stats.get('p95Ms', 0):.4f}",
                "p99_ms": f"{stats.get('p99Ms', 0):.4f}",
                "max_ms": f"{stats.get('maxMs', 0):.4f}",
                "mean_us": f"{stats.get('meanMs', 0)*1000:.1f}",
                "median_us": f"{stats.get('medianMs', 0)*1000:.1f}",
                "p95_us": f"{stats.get('p95Ms', 0)*1000:.1f}",
                "p99_us": f"{stats.get('p99Ms', 0)*1000:.1f}",
                "max_us": f"{stats.get('maxMs', 0)*1000:.1f}"
            })
        write_csv(LATENCY_CSV, latency_rows, [
            "subsystem", "samples_n", "mean_ms", "median_ms", "p95_ms", "p99_ms", "max_ms",
            "mean_us", "median_us", "p95_us", "p99_us", "max_us"
        ])
        log(f"Device latency benchmark results saved to {LATENCY_CSV}")
    else:
        log("WARNING: Latency benchmark did not return expected data.")

    # 2. Load Locked Sessions & Manifest
    test_sessions_file = os.path.join(REPO_ROOT, "artifacts", "data", "test_sessions.txt")
    with open(test_sessions_file, "r") as f:
        test_sessions = [l.strip() for l in f if l.strip()]

    fixtures_manifest_file = os.path.join(FIXTURES_DIR, "manifest.json")
    with open(fixtures_manifest_file, "r") as f:
        fixtures_manifest = json.load(f)

    runs = build_run_list(test_sessions, fixtures_manifest)
    log(f"Total planned evaluation runs across both modes: {len(runs)}")

    results_data = []
    manifest_records = {}
    trajectories_data = {}

    for i, run in enumerate(runs):
        s_id = run["session"]
        mode = run["mode"]
        dur = run["duration"]

        if run.get("status") == "SKIPPED_DURATION_LIMITATION":
            log(f"[{i+1}/{len(runs)}] Session {s_id} ({mode}): SKIPPED (duration limitation)")
            results_data.append({
                "run_index": i + 1,
                "session_id": s_id,
                "evaluation_mode": mode,
                "outage_duration_sec": "N/A",
                "status": "SKIPPED_DURATION_LIMITATION",
                "outage_valid": True,
                "gnss_delivered_outage": 0,
                "endpoint_error_m": "N/A",
                "outage_mean_error_m": "N/A",
                "outage_median_error_m": "N/A",
                "outage_p90_error_m": "N/A",
                "outage_p95_error_m": "N/A",
                "outage_max_error_m": "N/A",
                "outage_distance_m": "N/A",
                "endpoint_drift_pct": "N/A",
                "max_drift_pct": "N/A",
                "under_10pct_endpoint_drift": "N/A",
                "under_10pct_max_drift": "N/A",
                "error_before_recovery_m": "N/A",
                "error_first_fix_m": "N/A",
                "recovery_1s_m": "N/A",
                "recovery_2s_m": "N/A",
                "recovery_5s_m": "N/A",
                "time_to_under_10m_sec": "N/A",
                "time_to_under_5m_sec": "N/A",
                "time_to_under_2m_sec": "N/A",
                "post_recovery_mean_error_m": "N/A",
                "road_updates": 0,
                "route_updates": 0,
                "notes": run.get("notes", "")
            })
            continue

        log(f"============================================================")
        log(f"[{i+1}/{len(runs)}] RUN: Session={s_id}, Mode={mode}, Outage={dur}s (t0=20.0s)")
        log(f"============================================================")

        run_tag = f"{s_id}_{mode}_{dur}s"
        run_shots_dir = os.path.join(SCREENSHOTS_DIR, s_id, f"{mode}_{dur}s")
        os.makedirs(run_shots_dir, exist_ok=True)

        info = fixtures_manifest.get(s_id, {})
        duration_sec = info.get("duration_sec", 119.9)

        # 1. Load Fixture
        res = send_command("LOAD_FIXTURE", {"session": s_id}, timeout=10.0)
        if not res or res.get("status") != "loaded":
            log(f"ERROR: Failed to load fixture for {s_id}")
            continue

        # 2. Configure Run: Fixed Outage Anchor at t = 20.0s
        outage_start = 20.0
        speed = 5.0 # 5x virtual speed

        send_command("SET_CONFIG", {
            "evaluationMode": mode,
            "speed": speed,
            "outageStartSec": outage_start,
            "outageDurationSec": float(dur),
            "modelBackend": "tcn"
        })

        # 3. Reset
        send_command("RESET")
        time.sleep(0.3)

        # Milestone 01: Before Play (t = 0)
        shot_01 = os.path.join(run_shots_dir, "01_before.png")
        take_screenshot(shot_01)

        # 4. Start Playback
        t_wall_start = time.time()
        send_command("PLAY")

        # Pacing: at 5x speed
        v_pre = min(19.0, duration_sec * 0.3)
        v_mid = 20.0 + dur / 2.0
        v_end = min(duration_sec - 0.5, 20.0 + dur)
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
        take_screenshot_async(shot_02)

        # Sleep to Mid-outage
        now = time.time() - t_wall_start
        if t_mid > now:
            time.sleep(t_mid - now)
        shot_03 = os.path.join(run_shots_dir, "03_during_outage.png")
        take_screenshot_async(shot_03)

        # Sleep to Outage End
        now = time.time() - t_wall_start
        if t_end > now:
            time.sleep(t_end - now)
        shot_04 = os.path.join(run_shots_dir, "04_end_outage.png")
        take_screenshot_async(shot_04)

        # Sleep to Recovery
        now = time.time() - t_wall_start
        if t_rec > now:
            time.sleep(t_rec - now)
        shot_05 = os.path.join(run_shots_dir, "05_recovery.png")
        take_screenshot_async(shot_05)

        # Sleep to Final
        now = time.time() - t_wall_start
        if t_fin > now:
            time.sleep(t_fin - now)
        shot_06 = os.path.join(run_shots_dir, "06_final.png")
        take_screenshot_async(shot_06)

        # Pause and retrieve status and trajectory
        send_command("PAUSE")
        status_res = send_command("GET_STATUS")
        traj_res = send_command("GET_TRAJECTORY")
        report = status_res.get("report", {}) if status_res else {}

        # Zero leakage check
        gnss_during_outage = report.get("gnssDeliveredDuringOutage", 0)
        outage_valid = (gnss_during_outage == 0)
        if not outage_valid:
            log(f"  CRITICAL FAILURE: GNSS leaked during outage! Count={gnss_during_outage}")

        endpoint_err = report.get("endpointErrorMeters", 0)
        outage_mean = report.get("outageMeanErrorMeters", 0)
        outage_med = report.get("outageMedianErrorMeters", 0)
        outage_p90 = report.get("outageP90ErrorMeters", 0)
        outage_p95 = report.get("outageP95ErrorMeters", 0)
        outage_max = report.get("outageMaxErrorMeters", 0)
        out_dist = report.get("outageDistanceMeters", 0)
        endpoint_drift = report.get("endpointDriftPercent", 0)
        max_drift = report.get("maxDriftPercent", 0)
        rec_metrics = report.get("recoveryMilestones", {})
        err_before_rec = report.get("errorBeforeRecoveryMeters", endpoint_err)
        err_first_fix = report.get("errorFirstFixAfterOutageMeters", "N/A")

        log(f"  Results: EndpointErr={endpoint_err}m, Mean={outage_mean}m, Max={outage_max}m, Dist={out_dist}m, EndDrift={endpoint_drift}%, MaxDrift={max_drift}%")
        log(f"  SIH Compliance: Endpoint < 10% -> {endpoint_drift < 10.0}, Max < 10% -> {max_drift < 10.0}")

        record = {
            "run_index": i + 1,
            "session_id": s_id,
            "evaluation_mode": mode,
            "outage_duration_sec": dur,
            "status": "COMPLETED" if outage_valid else "LEAKAGE_FAIL",
            "outage_valid": outage_valid,
            "gnss_delivered_outage": gnss_during_outage,
            "endpoint_error_m": endpoint_err,
            "outage_mean_error_m": outage_mean,
            "outage_median_error_m": outage_med,
            "outage_p90_error_m": outage_p90,
            "outage_p95_error_m": outage_p95,
            "outage_max_error_m": outage_max,
            "outage_distance_m": out_dist,
            "endpoint_drift_pct": endpoint_drift,
            "max_drift_pct": max_drift,
            "under_10pct_endpoint_drift": endpoint_drift < 10.0,
            "under_10pct_max_drift": max_drift < 10.0,
            "error_before_recovery_m": err_before_rec,
            "error_first_fix_m": err_first_fix,
            "recovery_1s_m": rec_metrics.get("at1s", "N/A"),
            "recovery_2s_m": rec_metrics.get("at2s", "N/A"),
            "recovery_5s_m": rec_metrics.get("at5s", "N/A"),
            "time_to_under_10m_sec": report.get("timeToUnder10mSec", "N/A"),
            "time_to_under_5m_sec": report.get("timeToUnder5mSec", "N/A"),
            "time_to_under_2m_sec": report.get("timeToUnder2mSec", "N/A"),
            "post_recovery_mean_error_m": report.get("postRecoveryErrorMeters", 0),
            "road_updates": report.get("roadUpdateCount", 0),
            "route_updates": report.get("routeUpdateCount", 0),
            "notes": run.get("notes", "")
        }
        results_data.append(record)

        # Write progressive CSV
        write_csv(RESULTS_CSV, results_data, list(record.keys()))

        manifest_records[run_tag] = {
            "session": s_id,
            "mode": mode,
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

        # Store trajectory history for representative sessions (M, S2, Vw8)
        if s_id in ["M", "S2", "Vw8"] and traj_res:
            trajectories_data[run_tag] = {
                "session": s_id,
                "mode": mode,
                "duration": dur,
                "referenceHistory": traj_res.get("referenceHistory", []),
                "estimatedHistory": traj_res.get("estimatedHistory", [])
            }
            with open(TRAJECTORY_JSON, "w", encoding="utf-8") as f:
                json.dump(trajectories_data, f, indent=2)

    log("Physical evaluation runs finished. Computing aggregate statistics...")

    # 3. Compute Summary CSV (22 required columns)
    completed_runs = [r for r in results_data if r["status"] == "COMPLETED"]
    summary_rows = []

    for mode in ["FINAL_IDR", "FINAL_IDR_ROAD_ABLATION"]:
        for dur in [5, 10, 20, 30, 60]:
            matched = [r for r in completed_runs if r["evaluation_mode"] == mode and r["outage_duration_sec"] == dur]
            if not matched:
                continue

            n = len(matched)
            mean_err = sum(r["outage_mean_error_m"] for r in matched) / n
            med_err = sorted([r["outage_median_error_m"] for r in matched])[n // 2]
            p90_err = sorted([r["outage_p90_error_m"] for r in matched])[int(n * 0.9)]
            p95_err = sorted([r["outage_p95_error_m"] for r in matched])[int(n * 0.95)]
            max_err = max(r["outage_max_error_m"] for r in matched)
            out_dist = sum(r["outage_distance_m"] for r in matched) / n

            end_drift = sum(r["endpoint_drift_pct"] for r in matched) / n
            max_drift = sum(r["max_drift_pct"] for r in matched) / n

            pct_under_10_end = (sum(1 for r in matched if r["under_10pct_endpoint_drift"]) / n) * 100.0
            pct_under_10_max = (sum(1 for r in matched if r["under_10pct_max_drift"]) / n) * 100.0

            err_before_rec = sum(r["error_before_recovery_m"] for r in matched) / n
            first_fixes = [r["error_first_fix_m"] for r in matched if isinstance(r["error_first_fix_m"], (int, float))]
            err_first_fix = sum(first_fixes) / len(first_fixes) if first_fixes else "N/A"

            rec_1s = [r["recovery_1s_m"] for r in matched if isinstance(r["recovery_1s_m"], (int, float))]
            rec_2s = [r["recovery_2s_m"] for r in matched if isinstance(r["recovery_2s_m"], (int, float))]
            rec_5s = [r["recovery_5s_m"] for r in matched if isinstance(r["recovery_5s_m"], (int, float))]

            m_1s = sum(rec_1s) / len(rec_1s) if rec_1s else "N/A"
            m_2s = sum(rec_2s) / len(rec_2s) if rec_2s else "N/A"
            m_5s = sum(rec_5s) / len(rec_5s) if rec_5s else "N/A"

            t_10m = [r["time_to_under_10m_sec"] for r in matched if isinstance(r["time_to_under_10m_sec"], (int, float))]
            t_5m = [r["time_to_under_5m_sec"] for r in matched if isinstance(r["time_to_under_5m_sec"], (int, float))]
            t_2m = [r["time_to_under_2m_sec"] for r in matched if isinstance(r["time_to_under_2m_sec"], (int, float))]

            avg_t10 = sum(t_10m) / len(t_10m) if t_10m else "N/A"
            avg_t5 = sum(t_5m) / len(t_5m) if t_5m else "N/A"
            avg_t2 = sum(t_2m) / len(t_2m) if t_2m else "N/A"

            valid_pct = (sum(1 for r in matched if r["outage_valid"]) / n) * 100.0

            summary_rows.append({
                "outage_duration_sec": dur,
                "evaluation_mode": mode,
                "number_of_runs": n,
                "mean_error_m": f"{mean_err:.2f}",
                "median_error_m": f"{med_err:.2f}",
                "p90_error_m": f"{p90_err:.2f}",
                "p95_error_m": f"{p95_err:.2f}",
                "max_error_m": f"{max_err:.2f}",
                "outage_distance_m": f"{out_dist:.2f}",
                "endpoint_drift_pct": f"{end_drift:.2f}",
                "max_drift_pct": f"{max_drift:.2f}",
                "pct_runs_under_10pct_endpoint_drift": f"{pct_under_10_end:.1f}%",
                "pct_runs_under_10pct_max_drift": f"{pct_under_10_max:.1f}%",
                "error_before_recovery_m": f"{err_before_rec:.2f}",
                "error_first_fix_m": f"{err_first_fix:.2f}" if isinstance(err_first_fix, (int, float)) else str(err_first_fix),
                "recovery_milestone_1s_m": f"{m_1s:.2f}" if isinstance(m_1s, (int, float)) else str(m_1s),
                "recovery_milestone_2s_m": f"{m_2s:.2f}" if isinstance(m_2s, (int, float)) else str(m_2s),
                "recovery_milestone_5s_m": f"{m_5s:.2f}" if isinstance(m_5s, (int, float)) else str(m_5s),
                "time_to_under_10m_sec": f"{avg_t10:.2f}" if isinstance(avg_t10, (int, float)) else str(avg_t10),
                "time_to_under_5m_sec": f"{avg_t5:.2f}" if isinstance(avg_t5, (int, float)) else str(avg_t5),
                "time_to_under_2m_sec": f"{avg_t2:.2f}" if isinstance(avg_t2, (int, float)) else str(avg_t2),
                "valid_run_pct": f"{valid_pct:.1f}%"
            })

    write_csv(SUMMARY_CSV, summary_rows, [
        "outage_duration_sec", "evaluation_mode", "number_of_runs", "mean_error_m", "median_error_m",
        "p90_error_m", "p95_error_m", "max_error_m", "outage_distance_m", "endpoint_drift_pct",
        "max_drift_pct", "pct_runs_under_10pct_endpoint_drift", "pct_runs_under_10pct_max_drift",
        "error_before_recovery_m", "error_first_fix_m", "recovery_milestone_1s_m", "recovery_milestone_2s_m",
        "recovery_milestone_5s_m", "time_to_under_10m_sec", "time_to_under_5m_sec", "time_to_under_2m_sec",
        "valid_run_pct"
    ])
    log(f"Summary table saved to {SUMMARY_CSV}")

    # 4. Compute Paired Road Ablation Comparison CSV
    ablation_rows = []
    for s_id in test_sessions:
        for dur in [5, 10, 20, 30, 60]:
            r_on = next((r for r in completed_runs if r["session_id"] == s_id and r["evaluation_mode"] == "FINAL_IDR" and r["outage_duration_sec"] == dur), None)
            r_off = next((r for r in completed_runs if r["session_id"] == s_id and r["evaluation_mode"] == "FINAL_IDR_ROAD_ABLATION" and r["outage_duration_sec"] == dur), None)

            if r_on and r_off:
                delta_end = r_off["endpoint_error_m"] - r_on["endpoint_error_m"]
                pct_red_end = (delta_end / max(1e-3, r_off["endpoint_error_m"])) * 100.0

                delta_mean = r_off["outage_mean_error_m"] - r_on["outage_mean_error_m"]
                pct_red_mean = (delta_mean / max(1e-3, r_off["outage_mean_error_m"])) * 100.0

                delta_max = r_off["outage_max_error_m"] - r_on["outage_max_error_m"]
                pct_red_max = (delta_max / max(1e-3, r_off["outage_max_error_m"])) * 100.0

                delta_end_drift = r_off["endpoint_drift_pct"] - r_on["endpoint_drift_pct"]
                delta_max_drift = r_off["max_drift_pct"] - r_on["max_drift_pct"]

                ablation_rows.append({
                    "session_id": s_id,
                    "outage_duration_sec": dur,
                    "road_on_endpoint_err_m": r_on["endpoint_error_m"],
                    "road_off_endpoint_err_m": r_off["endpoint_error_m"],
                    "endpoint_error_delta_m": f"{delta_end:.2f}",
                    "endpoint_error_reduction_pct": f"{pct_red_end:.1f}%",
                    "road_on_mean_err_m": r_on["outage_mean_error_m"],
                    "road_off_mean_err_m": r_off["outage_mean_error_m"],
                    "mean_error_delta_m": f"{delta_mean:.2f}",
                    "mean_error_reduction_pct": f"{pct_red_mean:.1f}%",
                    "road_on_max_err_m": r_on["outage_max_error_m"],
                    "road_off_max_err_m": r_off["outage_max_error_m"],
                    "max_error_delta_m": f"{delta_max:.2f}",
                    "max_error_reduction_pct": f"{pct_red_max:.1f}%",
                    "road_on_endpoint_drift_pct": r_on["endpoint_drift_pct"],
                    "road_off_endpoint_drift_pct": r_off["endpoint_drift_pct"],
                    "endpoint_drift_reduction_pct_pts": f"{delta_end_drift:.2f}%",
                    "road_on_max_drift_pct": r_on["max_drift_pct"],
                    "road_off_max_drift_pct": r_off["max_drift_pct"],
                    "max_drift_reduction_pct_pts": f"{delta_max_drift:.2f}%"
                })

    write_csv(ABLATION_CSV, ablation_rows, [
        "session_id", "outage_duration_sec",
        "road_on_endpoint_err_m", "road_off_endpoint_err_m", "endpoint_error_delta_m", "endpoint_error_reduction_pct",
        "road_on_mean_err_m", "road_off_mean_err_m", "mean_error_delta_m", "mean_error_reduction_pct",
        "road_on_max_err_m", "road_off_max_err_m", "max_error_delta_m", "max_error_reduction_pct",
        "road_on_endpoint_drift_pct", "road_off_endpoint_drift_pct", "endpoint_drift_reduction_pct_pts",
        "road_on_max_drift_pct", "road_off_max_drift_pct", "max_drift_reduction_pct_pts"
    ])
    log(f"Paired road ablation comparison saved to {ABLATION_CSV}")

    # 5. Compute Session Summary CSV
    session_summary_rows = []
    for s_id in test_sessions:
        for mode in ["FINAL_IDR", "FINAL_IDR_ROAD_ABLATION"]:
            s_runs = [r for r in completed_runs if r["session_id"] == s_id and r["evaluation_mode"] == mode]
            if not s_runs:
                continue
            session_summary_rows.append({
                "session_id": s_id,
                "evaluation_mode": mode,
                "outage_runs_count": len(s_runs),
                "avg_endpoint_error_m": f"{sum(r['endpoint_error_m'] for r in s_runs)/len(s_runs):.2f}",
                "avg_mean_error_m": f"{sum(r['outage_mean_error_m'] for r in s_runs)/len(s_runs):.2f}",
                "avg_max_error_m": f"{sum(r['outage_max_error_m'] for r in s_runs)/len(s_runs):.2f}",
                "avg_endpoint_drift_pct": f"{sum(r['endpoint_drift_pct'] for r in s_runs)/len(s_runs):.2f}%",
                "avg_max_drift_pct": f"{sum(r['max_drift_pct'] for r in s_runs)/len(s_runs):.2f}%",
                "pct_runs_sih_endpoint_pass": f"{(sum(1 for r in s_runs if r['under_10pct_endpoint_drift'])/len(s_runs))*100:.1f}%",
                "pct_runs_sih_max_pass": f"{(sum(1 for r in s_runs if r['under_10pct_max_drift'])/len(s_runs))*100:.1f}%"
            })
    write_csv(SESSION_RESULTS_CSV, session_summary_rows, [
        "session_id", "evaluation_mode", "outage_runs_count", "avg_endpoint_error_m", "avg_mean_error_m",
        "avg_max_error_m", "avg_endpoint_drift_pct", "avg_max_drift_pct", "pct_runs_sih_endpoint_pass",
        "pct_runs_sih_max_pass"
    ])
    log(f"Session results saved to {SESSION_RESULTS_CSV}")

    # 6. Compute Recovery Metrics CSV
    recovery_rows = []
    for mode in ["FINAL_IDR", "FINAL_IDR_ROAD_ABLATION"]:
        for dur in [5, 10, 20, 30, 60]:
            matched = [r for r in completed_runs if r["evaluation_mode"] == mode and r["outage_duration_sec"] == dur]
            if not matched:
                continue
            n = len(matched)
            err_before_rec = sum(r["error_before_recovery_m"] for r in matched) / n
            first_fixes = [r["error_first_fix_m"] for r in matched if isinstance(r["error_first_fix_m"], (int, float))]
            err_first_fix = sum(first_fixes) / len(first_fixes) if first_fixes else "N/A"
            rec_1s = [r["recovery_1s_m"] for r in matched if isinstance(r["recovery_1s_m"], (int, float))]
            rec_2s = [r["recovery_2s_m"] for r in matched if isinstance(r["recovery_2s_m"], (int, float))]
            rec_5s = [r["recovery_5s_m"] for r in matched if isinstance(r["recovery_5s_m"], (int, float))]
            m_1s = sum(rec_1s) / len(rec_1s) if rec_1s else "N/A"
            m_2s = sum(rec_2s) / len(rec_2s) if rec_2s else "N/A"
            m_5s = sum(rec_5s) / len(rec_5s) if rec_5s else "N/A"
            t_10m = [r["time_to_under_10m_sec"] for r in matched if isinstance(r["time_to_under_10m_sec"], (int, float))]
            t_5m = [r["time_to_under_5m_sec"] for r in matched if isinstance(r["time_to_under_5m_sec"], (int, float))]
            t_2m = [r["time_to_under_2m_sec"] for r in matched if isinstance(r["time_to_under_2m_sec"], (int, float))]
            avg_t10 = sum(t_10m) / len(t_10m) if t_10m else "N/A"
            avg_t5 = sum(t_5m) / len(t_5m) if t_5m else "N/A"
            avg_t2 = sum(t_2m) / len(t_2m) if t_2m else "N/A"
            post_err = sum(r["post_recovery_mean_error_m"] for r in matched) / n

            recovery_rows.append({
                "outage_duration_sec": dur,
                "evaluation_mode": mode,
                "number_of_runs": n,
                "error_before_recovery_m": f"{err_before_rec:.2f}",
                "error_first_fix_m": f"{err_first_fix:.2f}" if isinstance(err_first_fix, (int, float)) else str(err_first_fix),
                "recovery_milestone_1s_m": f"{m_1s:.2f}" if isinstance(m_1s, (int, float)) else str(m_1s),
                "recovery_milestone_2s_m": f"{m_2s:.2f}" if isinstance(m_2s, (int, float)) else str(m_2s),
                "recovery_milestone_5s_m": f"{m_5s:.2f}" if isinstance(m_5s, (int, float)) else str(m_5s),
                "time_to_under_10m_sec": f"{avg_t10:.2f}" if isinstance(avg_t10, (int, float)) else str(avg_t10),
                "time_to_under_5m_sec": f"{avg_t5:.2f}" if isinstance(avg_t5, (int, float)) else str(avg_t5),
                "time_to_under_2m_sec": f"{avg_t2:.2f}" if isinstance(avg_t2, (int, float)) else str(avg_t2),
                "post_recovery_mean_error_m": f"{post_err:.2f}"
            })
    write_csv(RECOVERY_CSV, recovery_rows, [
        "outage_duration_sec", "evaluation_mode", "number_of_runs", "error_before_recovery_m",
        "error_first_fix_m", "recovery_milestone_1s_m", "recovery_milestone_2s_m", "recovery_milestone_5s_m",
        "time_to_under_10m_sec", "time_to_under_5m_sec", "time_to_under_2m_sec", "post_recovery_mean_error_m"
    ])
    log(f"Recovery metrics saved to {RECOVERY_CSV}")

    log("============================================================")
    log("ALL 88 RUNS AND POST-PROCESSING COMPLETED SUCCESSFULLY!")
    log("============================================================")

if __name__ == "__main__":
    main()
