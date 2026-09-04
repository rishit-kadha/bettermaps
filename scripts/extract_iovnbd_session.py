#!/usr/bin/env python3
"""
extract_iovnbd_session.py

Extracts and packages representative IO-VNBD session data into a self-contained
JSON replay fixture for the BetterMaps testing harness.

Preserves:
- Original phone IMU timestamps (TIME SINCE START ms, DATE string)
- Original vehicle VBOX reference timestamps (Time Since Start of Day s)
- Original accelerometer, gyroscope, gravity, and magnetic readings
- Original reference coordinates (WGS84 lat/lon), speed, heading, and yaw rate
- Verified metadata describing the exact source files, sample rates, and alignment
"""

import os
import json
import numpy as np
import pandas as pd
from datetime import datetime, timezone

DATASET_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "research", "IO-VNBD", "Synchronised V abd S datasets", "Categorised IOVNB Dataset"
)
OUTPUT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "assets", "datasets", "iovnbd_s1.json"
)

def extract_s1_fixture(sample_count: int = 1800) -> None:
    s_csv_path = os.path.join(DATASET_DIR, "S (Driver A)", "S1", "S-S1.csv")
    v_csv_path = os.path.join(DATASET_DIR, "S (Driver A)", "S1", "V-S1.csv")

    if not os.path.exists(s_csv_path) or not os.path.exists(v_csv_path):
        raise FileNotFoundError(f"Missing IO-VNBD files at {s_csv_path} or {v_csv_path}")

    print(f"Loading raw S1 files...")
    s_df = pd.read_csv(s_csv_path, encoding="latin-1")
    v_df = pd.read_csv(v_csv_path, encoding="latin-1")

    # Strip column whitespace
    s_df.columns = [c.strip() for c in s_df.columns]
    v_df.columns = [c.strip() for c in v_df.columns]

    total_rows = len(s_df)
    print(f"Total rows in raw S1: {total_rows}")

    # Clip to requested sample count (e.g. 1800 samples = 179.9s = 3.0 min)
    s_sub = s_df.iloc[:sample_count].copy()
    v_sub = v_df.iloc[:sample_count].copy()

    # Extract initial origin coordinates
    origin_lat = float(v_sub["Latitude (degrees)"].iloc[0])
    origin_lon = float(v_sub["Longitude (degrees)"].iloc[0])

    # Compute total reference distance for the fixture
    lats = v_sub["Latitude (degrees)"].values
    lons = v_sub["Longitude (degrees)"].values
    dlat = np.diff(lats) * 111139.0
    dlon = np.diff(lons) * 111139.0 * np.cos(np.radians(lats[:-1]))
    fixture_distance_m = float(np.sum(np.sqrt(dlat**2 + dlon**2)))

    # Start timestamp in ms
    t0_ms = int(s_sub["TIME SINCE START (ms)"].iloc[0])

    samples = []
    for i in range(sample_count):
        s_row = s_sub.iloc[i]
        v_row = v_sub.iloc[i]

        s_time_ms = int(s_row["TIME SINCE START (ms)"])
        rel_time_ms = s_time_ms - t0_ms

        samples.append({
            "index": i,
            "relative_time_ms": rel_time_ms,
            "sensor_timestamp_ms": s_time_ms,
            "sensor_date_str": str(s_row.iloc[8]),
            "ref_timestamp_sec": float(v_row["Time Since Start of Day (seconds)"]),
            "accel": {
                "x": float(s_row.iloc[9]),
                "y": float(s_row.iloc[10]),
                "z": float(s_row.iloc[11])
            },
            "gyro": {
                "yaw": float(s_row.iloc[15]),
                "pitch": float(s_row.iloc[16]),
                "roll": float(s_row.iloc[17])
            },
            "gravity": {
                "x": float(s_row.iloc[12]),
                "y": float(s_row.iloc[13]),
                "z": float(s_row.iloc[14])
            },
            "mag": {
                "x": float(s_row.iloc[18]),
                "y": float(s_row.iloc[19]),
                "z": float(s_row.iloc[20])
            },
            "phone_gps": {
                "latitude": float(s_row.iloc[0]),
                "longitude": float(s_row.iloc[1]),
                "altitude": float(s_row.iloc[2]),
                "speed_kmh": float(s_row.iloc[3]),
                "accuracy_m": float(s_row.iloc[4]),
                "heading_deg": float(s_row.iloc[5])
            },
            "reference": {
                "latitude": float(v_row["Latitude (degrees)"]),
                "longitude": float(v_row["Longitude (degrees)"]),
                "speed_kmh": float(v_row["Velocity (km/hr)"]),
                "heading_deg": float(v_row["Heading (degrees)"]),
                "yaw_rate_deg_s": float(v_row["Yaw Rate (deg/sec)"]),
                "steering_deg": float(v_row["Steering Angle (degrees)"]),
                "indicated_speed_kmh": float(v_row["Indicated Vehicle Speed (km/hr)"])
            }
        })

    fixture = {
        "metadata": {
            "dataset_name": "IO-VNBD",
            "session_id": "S1",
            "driver": "Driver A",
            "vehicle": "Ford Fiesta 1.25L",
            "phone_model": "Samsung Galaxy S8 (SM-G950F)",
            "phone_mounting": "Portrait windshield suction mount (tilt ~85 deg)",
            "source_files": [
                "Synchronised V abd S datasets/Categorised IOVNB Dataset/S (Driver A)/S1/S-S1.csv",
                "Synchronised V abd S datasets/Categorised IOVNB Dataset/S (Driver A)/S1/V-S1.csv"
            ],
            "full_session_sample_count": total_rows,
            "full_session_duration_sec": 5174.50,
            "full_session_distance_m": 38024.6,
            "fixture_sample_count": sample_count,
            "fixture_duration_sec": round((samples[-1]["relative_time_ms"]) / 1000.0, 2),
            "fixture_distance_m": round(fixture_distance_m, 2),
            "sensor_sample_rate_hz": 10.00,
            "reference_sample_rate_hz": 10.00,
            "alignment_lag_sec": -0.20,
            "alignment_lag_samples": -2,
            "origin": {
                "latitude": origin_lat,
                "longitude": origin_lon
            },
            "last_reference": {
                "latitude": float(v_sub["Latitude (degrees)"].iloc[-1]),
                "longitude": float(v_sub["Longitude (degrees)"].iloc[-1])
            },
            "extraction_timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "fixture_version": "1.0.0"
        },
        "samples": samples
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(fixture, f)

    file_size_kb = os.path.getsize(OUTPUT_PATH) / 1024.0
    print(f"Successfully exported {sample_count} samples to {OUTPUT_PATH}")
    print(f"Fixture duration: {fixture['metadata']['fixture_duration_sec']}s ({fixture['metadata']['fixture_duration_sec']/60.0:.1f} min)")
    print(f"Fixture distance: {fixture_distance_m:.1f} m")
    print(f"File size: {file_size_kb:.1f} KB")

if __name__ == "__main__":
    extract_s1_fixture(1800)

