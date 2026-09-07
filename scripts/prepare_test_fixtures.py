#!/usr/bin/env python3
"""
prepare_test_fixtures.py

Extracts all locked test split sessions from the raw IO-VNBD dataset
into JSON fixtures for on-device replay evaluation.
"""

import os
import glob
import json
import numpy as np
import pandas as pd

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_DIR = os.path.join(REPO_ROOT, "research", "IO-VNBD", "Synchronised V abd S datasets", "Categorised IOVNB Dataset")
TEST_SESSIONS_FILE = os.path.join(REPO_ROOT, "artifacts", "data", "test_sessions.txt")
OUTPUT_DIR = os.path.join(REPO_ROOT, "assets", "datasets", "test_fixtures")

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(TEST_SESSIONS_FILE, "r", encoding="utf-8") as f:
        test_ids = [line.strip() for line in f if line.strip()]

    print(f"Extracting fixtures for {len(test_ids)} locked test sessions from {BASE_DIR}...")
    manifest = {}

    for s_id in test_ids:
        s_files = glob.glob(os.path.join(BASE_DIR, "**", f"S-{s_id}.csv"), recursive=True)
        v_files = glob.glob(os.path.join(BASE_DIR, "**", f"V-{s_id}.csv"), recursive=True)
        if not s_files or not v_files:
            print(f"ERROR: Session files missing for {s_id}!")
            continue

        s_df = pd.read_csv(s_files[0], encoding="latin-1")
        v_df = pd.read_csv(v_files[0], encoding="latin-1")
        s_df.columns = [c.strip() for c in s_df.columns]
        v_df.columns = [c.strip() for c in v_df.columns]

        total_len = min(len(s_df), len(v_df))
        # Take up to 1,200 samples (120s of driving)
        n_samples = min(total_len, 1200)

        s_sub = s_df.iloc[:n_samples]
        v_sub = v_df.iloc[:n_samples]

        origin_lat = float(v_sub["Latitude (degrees)"].iloc[0])
        origin_lon = float(v_sub["Longitude (degrees)"].iloc[0])
        t0_ms = int(s_sub["TIME SINCE START (ms)"].iloc[0])

        samples = []
        for i in range(n_samples):
            sr = s_sub.iloc[i]
            vr = v_sub.iloc[i]
            s_time_ms = int(sr["TIME SINCE START (ms)"])
            samples.append({
                "index": i,
                "relative_time_ms": s_time_ms - t0_ms,
                "sensor_timestamp_ms": s_time_ms,
                "accel": {
                    "x": float(sr.iloc[9]),
                    "y": float(sr.iloc[10]),
                    "z": float(sr.iloc[11])
                },
                "gyro": {
                    "yaw": float(sr.iloc[15]),
                    "pitch": float(sr.iloc[16]),
                    "roll": float(sr.iloc[17])
                },
                "mag": {
                    "x": float(sr.iloc[18]),
                    "y": float(sr.iloc[19]),
                    "z": float(sr.iloc[20])
                },
                "phone_gps": {
                    "latitude": float(sr.iloc[0]),
                    "longitude": float(sr.iloc[1]),
                    "altitude": float(sr.iloc[2]),
                    "speed_kmh": float(sr.iloc[3]),
                    "accuracy_m": float(sr.iloc[4]),
                    "heading_deg": float(sr.iloc[5])
                },
                "reference": {
                    "latitude": float(vr["Latitude (degrees)"]),
                    "longitude": float(vr["Longitude (degrees)"]),
                    "speed_kmh": float(vr["Velocity (km/hr)"]),
                    "heading_deg": float(vr["Heading (degrees)"]),
                    "yaw_rate_deg_s": float(vr["Yaw Rate (deg/sec)"])
                }
            })

        duration_sec = round(samples[-1]["relative_time_ms"] / 1000.0, 2)
        fixture = {
            "metadata": {
                "session_id": s_id,
                "total_samples": n_samples,
                "duration_sec": duration_sec,
                "origin": {"latitude": origin_lat, "longitude": origin_lon},
                "source_s": os.path.relpath(s_files[0], REPO_ROOT),
                "source_v": os.path.relpath(v_files[0], REPO_ROOT)
            },
            "samples": samples
        }

        out_path = os.path.join(OUTPUT_DIR, f"iovnbd_{s_id}.json")
        with open(out_path, "w", encoding="utf-8") as fp:
            json.dump(fixture, fp)

        size_kb = os.path.getsize(out_path) / 1024.0
        manifest[s_id] = {
            "samples": n_samples,
            "duration_sec": duration_sec,
            "size_kb": round(size_kb, 1),
            "path": out_path
        }
        print(f"Extracted {s_id}: {n_samples} samples ({duration_sec}s) -> {size_kb:.1f} KB")

    manifest_path = os.path.join(OUTPUT_DIR, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as fp:
        json.dump(manifest, fp, indent=2)
    print(f"Wrote manifest to {manifest_path}")

if __name__ == "__main__":
    main()

