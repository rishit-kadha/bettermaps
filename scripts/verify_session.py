#!/usr/bin/env python3
"""
verify_session.py

Research validation and data-integrity inspector for BetterMaps sensor recording sessions.
Phase 2: Analyzes independent sensor streams (accel, gyro, mag, orientation, reference gnss)
Phase 3A: Analyzes dual-position recording (reference_gnss vs position_estimates) and
          verifies GNSS stream gate outage simulation intervals and event logging.

Usage:
    python scripts/verify_session.py <path_to_session_directory>
"""

import sys
import os
import json
import csv
import math

def analyze_stream(filepath, stream_name):
    if not os.path.exists(filepath):
        print(f"  [-] {stream_name}: File not found ({filepath})")
        return None

    sample_count = 0
    monotonicity_violations = 0
    duplicate_timestamps = 0
    prev_ts = None
    timestamps = []
    sample_rows = []

    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            sample_count += 1
            ts = int(row['timestamp_ns'])
            timestamps.append(ts)
            sample_rows.append(row)

            if prev_ts is not None:
                if ts < prev_ts:
                    monotonicity_violations += 1
                elif ts == prev_ts:
                    duplicate_timestamps += 1
            prev_ts = ts

    if sample_count == 0:
        print(f"  [-] {stream_name}: Empty file (0 samples)")
        return None

    duration_ns = timestamps[-1] - timestamps[0] if sample_count > 1 else 0
    duration_s = duration_ns / 1e9
    rate_hz = (sample_count - 1) / duration_s if duration_s > 0 else 0.0

    # Calculate delta-t statistics (in milliseconds)
    dt_ms_list = [(timestamps[i] - timestamps[i-1]) / 1e6 for i in range(1, len(timestamps))]
    if dt_ms_list:
        mean_dt = sum(dt_ms_list) / len(dt_ms_list)
        var_dt = sum((x - mean_dt) ** 2 for x in dt_ms_list) / len(dt_ms_list)
        std_dt = math.sqrt(var_dt)
        min_dt = min(dt_ms_list)
        max_dt = max(dt_ms_list)
    else:
        mean_dt = std_dt = min_dt = max_dt = 0.0

    stats = {
        'stream': stream_name,
        'sample_count': sample_count,
        'duration_s': duration_s,
        'rate_hz': rate_hz,
        'min_ts_ns': timestamps[0],
        'max_ts_ns': timestamps[-1],
        'monotonicity_violations': monotonicity_violations,
        'duplicate_timestamps': duplicate_timestamps,
        'mean_dt_ms': mean_dt,
        'std_dt_ms': std_dt,
        'min_dt_ms': min_dt,
        'max_dt_ms': max_dt,
        'rows': sample_rows
    }
    return stats

def analyze_events(events_path):
    if not os.path.exists(events_path):
        return []
    events = []
    with open(events_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            events.append({
                'timestamp_ns': int(row['timestamp_ns']),
                'timestamp_ms': int(row['timestamp_ms']),
                'event_type': row.get('event_type', ''),
                'event_value': row.get('value') or row.get('event_value', ''),
                'extra_json': row.get('extra_json', '')
            })
    return events

def analyze_outages(events, position_estimates_stats, gnss_stats):
    """
    Identifies GNSS outage intervals from events and cross-references:
    1. Reference GNSS (must continue recording during outage)
    2. Position Estimates (must have 0 valid estimates during outage)
    """
    print("\n[PHASE 3A: GNSS OUTAGE SIMULATION & DUAL-RECORDING ANALYSIS]")

    # Find outage intervals (stream disabled -> stream enabled) using timestamp_ms
    outages = []
    current_outage = None

    for ev in events:
        if ev['event_type'] == 'GNSS_STREAM':
            if ev['event_value'] == 'disabled':
                current_outage = {
                    'start_ms': ev['timestamp_ms'],
                    'start_ns': ev['timestamp_ns'],
                }
            elif ev['event_value'] == 'enabled' and current_outage is not None:
                current_outage['end_ms'] = ev['timestamp_ms']
                current_outage['end_ns'] = ev['timestamp_ns']
                outages.append(current_outage)
                current_outage = None

    if current_outage is not None:
        # Outage continued until session end
        max_ms = 0
        if gnss_stats and gnss_stats['rows']:
            max_ms = max(max_ms, max(int(r.get('timestamp_ms', 0)) for r in gnss_stats['rows']))
        if position_estimates_stats and position_estimates_stats['rows']:
            max_ms = max(max_ms, max(int(r.get('timestamp_ms', 0)) for r in position_estimates_stats['rows']))
        current_outage['end_ms'] = max_ms
        current_outage['end_ns'] = 0
        outages.append(current_outage)

    print(f"  Total Outage Events Logged: {len(events)}")
    print(f"  Simulated Outage Periods  : {len(outages)}")

    if not outages:
        print("  [NOTE] No simulated GNSS outages triggered during this session (nominal continuous operation).")
        return

    for idx, out in enumerate(outages, 1):
        start_ms = out['start_ms']
        end_ms = out['end_ms']
        duration_s = (end_ms - start_ms) / 1000.0 if end_ms > start_ms else 0.0
        print(f"\n  --- Outage #{idx} (Duration: {duration_s:.2f}s) ---")
        print(f"      Time Window (Epoch MS): {start_ms} -> {end_ms}")

        # Check reference GNSS during this window
        gnss_count_during_outage = 0
        if gnss_stats:
            for r in gnss_stats['rows']:
                ts_ms = int(r.get('timestamp_ms', 0))
                if start_ms <= ts_ms <= end_ms:
                    gnss_count_during_outage += 1

        # Check position estimates during this window
        pos_valid_count_during_outage = 0
        pos_blocked_count_during_outage = 0
        if position_estimates_stats:
            for r in position_estimates_stats['rows']:
                ts_ms = int(r.get('timestamp_ms', 0))
                if start_ms <= ts_ms <= end_ms:
                    is_valid = str(r.get('valid', '')).lower() in ('1', 'true')
                    if is_valid:
                        pos_valid_count_during_outage += 1
                    else:
                        pos_blocked_count_during_outage += 1

        print(f"      Reference GNSS Fixes in Window : {gnss_count_during_outage}")
        print(f"      Valid Position Estimates in Win: {pos_valid_count_during_outage}")
        print(f"      Blocked Estimates in Win       : {pos_blocked_count_during_outage}")

        # Verification tests:
        # 1. Phone GNSS must NOT be stopped (fixes should continue arriving)
        if gnss_count_during_outage > 0:
            print("      [PASS] Reference GNSS continued updating during outage (Android GPS was NOT killed).")
        else:
            print("      [INFO] 0 GNSS fixes in this window (expected if short indoor test or cold fix).")

        # 2. PositioningEngine must NOT produce valid estimates during outage (no fake dead reckoning!)
        if pos_valid_count_during_outage == 0:
            print("      [PASS] Zero valid position estimates produced during outage (No fake dead reckoning).")
        else:
            print("      [FAIL] PositioningEngine produced valid fixes during blocked outage!")

def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/verify_session.py <session_dir>")
        sys.exit(1)

    session_dir = sys.argv[1]
    if not os.path.isdir(session_dir):
        print(f"Error: Directory not found: {session_dir}")
        sys.exit(1)

    print("=" * 70)
    print(" BETTERMAPS SENSOR RECORDING SESSION INSPECTOR (PHASE 3A)")
    print("=" * 70)
    print(f"Session Path: {os.path.abspath(session_dir)}\n")

    # 1. Inspect metadata.json
    meta_path = os.path.join(session_dir, 'metadata.json')
    if os.path.exists(meta_path):
        with open(meta_path, 'r', encoding='utf-8') as f:
            meta = json.load(f)
        print("[METADATA]")
        print(f"  Session ID             : {meta.get('sessionId')}")
        print(f"  Duration               : {meta.get('durationSeconds', 0):.2f} seconds")
        dev = meta.get('device', {})
        print(f"  Device                 : {dev.get('brand')} {dev.get('model')} (Android {dev.get('androidVersion')}, SDK {dev.get('sdkInt')})")
        print(f"  Dropped Samples        : {meta.get('droppedQueueSamples', 0)}")
        print(f"  Simulated Outage Used  : {meta.get('simulatedOutageUsed', False)}")
        print(f"  Total GNSS (Ref)       : {meta.get('totalGnssSamples', 0)}")
        print(f"  Total Position Est.    : {meta.get('totalPositionEstimateSamples', 0)}")
    else:
        print("[WARNING] metadata.json not found!")

    print("\n[STREAM DATA INTEGRITY ANALYSIS]")

    streams = [
        ('accelerometer.csv', 'Accelerometer (Raw)'),
        ('gyroscope.csv', 'Gyroscope (Raw)'),
        ('magnetometer.csv', 'Magnetometer (Raw)'),
        ('orientation.csv', 'Derived Orientation (Attitude)'),
        ('gnss.csv', 'Reference GNSS (Android Fused Location)'),
        ('position_estimates.csv', 'Position Estimates (PositioningEngine Output)'),
        ('events.csv', 'Simulation Events (Gate State Changes)')
    ]

    all_stats = {}
    for filename, display_name in streams:
        path = os.path.join(session_dir, filename)
        stats = analyze_stream(path, display_name)
        if stats:
            all_stats[filename] = stats
            status_tag = "[PASS]" if (stats['monotonicity_violations'] == 0 and stats['duplicate_timestamps'] == 0) else "[WARN]"
            print(f"\n{status_tag} {display_name}:")
            print(f"    Samples             : {stats['sample_count']:,}")
            print(f"    Measured Rate       : {stats['rate_hz']:.1f} Hz")
            print(f"    Duration            : {stats['duration_s']:.2f} s")
            print(f"    Monotonic Violations: {stats['monotonicity_violations']}")
            print(f"    Duplicate Timestamps: {stats['duplicate_timestamps']}")
            if stats['sample_count'] > 1:
                print(f"    Nominal Period dt   : {stats['mean_dt_ms']:.2f} ms (+/-{stats['std_dt_ms']:.2f} ms jitter, range: [{stats['min_dt_ms']:.2f}, {stats['max_dt_ms']:.2f}] ms)")

    # Accelerometer physical gravity verification
    if 'accelerometer.csv' in all_stats:
        accel_rows = all_stats['accelerometer.csv']['rows']
        norms = [math.sqrt(float(r['x'])**2 + float(r['y'])**2 + float(r['z'])**2) for r in accel_rows]
        mean_norm = sum(norms) / len(norms)
        print(f"\n[PHYSICAL VALIDATION]")
        print(f"  Mean Acceleration Magnitude: {mean_norm:.3f} m/s^2 (Earth gravity ~ 9.807 m/s^2)")
        if abs(mean_norm - 9.81) < 1.0:
            print("  [SUCCESS] Accelerometer norm consistent with stationary/quasi-stationary gravity vector.")

    # Gyroscope noise floor verification
    if 'gyroscope.csv' in all_stats:
        gyro_rows = all_stats['gyroscope.csv']['rows']
        gyro_mags = [math.sqrt(float(r['x'])**2 + float(r['y'])**2 + float(r['z'])**2) for r in gyro_rows]
        mean_gyro = sum(gyro_mags) / len(gyro_mags)
        print(f"  Mean Angular Velocity Rate : {mean_gyro:.4f} rad/s ({math.degrees(mean_gyro):.2f} deg/s)")

    # Outage & Dual-Position Verification
    events_path = os.path.join(session_dir, 'events.csv')
    events = analyze_events(events_path)
    analyze_outages(
        events,
        all_stats.get('position_estimates.csv'),
        all_stats.get('gnss.csv')
    )

    print("\n" + "=" * 70)
    print(" VERIFICATION COMPLETE")
    print("=" * 70)

if __name__ == '__main__':
    main()

