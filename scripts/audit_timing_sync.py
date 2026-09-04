import os
import csv
import sys
import pandas as pd
import numpy as np

sys.stdout.reconfigure(encoding='utf-8')

DATASET_ROOT = r"c:\Users\rkadh\OneDrive\Documents\GitHub\bettermaps\research\IO-VNBD"
SYNC_CAT = os.path.join(DATASET_ROOT, "Synchronised V abd S datasets", "Categorised IOVNB Dataset")

def clean_cols(df):
    df.columns = [c.strip() for c in df.columns]
    return df

def analyze_timing_and_sync(run_name, s_rel_path, v_rel_path):
    s_path = os.path.join(SYNC_CAT, s_rel_path)
    v_path = os.path.join(SYNC_CAT, v_rel_path)
    
    print(f"\n=======================================================")
    print(f"ANALYZING RUN: {run_name}")
    print(f"S file: {s_rel_path}")
    print(f"V file: {v_rel_path}")
    print(f"=======================================================")
    
    df_s = clean_cols(pd.read_csv(s_path, encoding='latin1'))
    df_v = clean_cols(pd.read_csv(v_path, encoding='latin1'))
    
    print(f"df_s shape: {df_s.shape}, df_v shape: {df_v.shape}")
    
    # Analyze S timing
    t_s_col = next((c for c in df_s.columns if "TIME SINCE START" in c.upper()), None)
    date_col = next((c for c in df_s.columns if "DATE" in c.upper()), None)
    
    if t_s_col:
        s_t_ms = df_s[t_s_col].values.astype(float)
        dt_s_ms = np.diff(s_t_ms)
        print(f"S Time Since Start (ms):")
        print(f"  Start: {s_t_ms[0]} ms, End: {s_t_ms[-1]} ms, Span: {(s_t_ms[-1]-s_t_ms[0])/1000.0:.2f} s")
        print(f"  dt mean: {np.mean(dt_s_ms):.3f} ms, std: {np.std(dt_s_ms):.3f} ms, median: {np.median(dt_s_ms):.3f} ms")
        print(f"  dt min: {np.min(dt_s_ms):.3f} ms, max: {np.max(dt_s_ms):.3f} ms")
        print(f"  dt unique counts (top 5): {pd.Series(np.round(dt_s_ms, 1)).value_index_counts() if hasattr(pd.Series(np.round(dt_s_ms, 1)), 'value_index_counts') else pd.Series(np.round(dt_s_ms, 1)).value_counts().head(5).to_dict()}")

    # Analyze V timing
    t_v_col = next((c for c in df_v.columns if "TIME SINCE START OF DAY" in c.upper()), None)
    sample_period_col = next((c for c in df_v.columns if "SAMPLE PERIOD" in c.upper() or "SAMPLEPERIOD" in c.upper()), None)
    
    if t_v_col:
        v_t_s = df_v[t_v_col].values.astype(float)
        dt_v_s = np.diff(v_t_s)
        print(f"\nV Time Since Start of Day (s):")
        print(f"  Start: {v_t_s[0]} s, End: {v_t_s[-1]} s, Span: {v_t_s[-1]-v_t_s[0]:.2f} s")
        print(f"  dt mean: {np.mean(dt_v_s):.4f} s, std: {np.std(dt_v_s):.4f} s, median: {np.median(dt_v_s):.4f} s")
        print(f"  dt min: {np.min(dt_v_s):.4f} s, max: {np.max(dt_v_s):.4f} s")
        print(f"  dt unique counts (top 5): {pd.Series(np.round(dt_v_s, 3)).value_counts().head(5).to_dict()}")
        
    if sample_period_col:
        sp = df_v[sample_period_col].values
        print(f"  Reported Sample period: mean={np.mean(sp):.4f}, min={np.min(sp)}, max={np.max(sp)}")

    # Check GPS Speed update frequency in S
    gps_spd_col = next((c for c in df_s.columns if "GPS SPEED" in c.upper()), None)
    if gps_spd_col:
        spd_vals = df_s[gps_spd_col].values
        changes = np.where(np.diff(spd_vals) != 0)[0]
        if len(changes) > 0:
            change_intervals = np.diff(changes)
            print(f"\nS GPS Speed updates:")
            print(f"  Number of value changes: {len(changes)} over {len(df_s)} rows")
            print(f"  Mean interval between changes: {np.mean(change_intervals):.1f} rows ({np.mean(change_intervals)*100:.0f} ms)")
            print(f"  Median interval between changes: {np.median(change_intervals):.1f} rows")

    # Check alignment between S and V:
    # 1. Compare speeds: S GPS Speed (km/h) vs V Velocity (km/h)
    v_spd_col = next((c for c in df_v.columns if c.upper() == "VELOCITY (KM/HR)"), None)
    if not v_spd_col:
        v_spd_col = next((c for c in df_v.columns if "VELOCITY" in c.upper()), None)
        
    min_len = min(len(df_s), len(df_v))
    if gps_spd_col and v_spd_col:
        s_spd = df_s[gps_spd_col].values[:min_len].astype(float)
        v_spd = df_v[v_spd_col].values[:min_len].astype(float)
        corr_spd = np.corrcoef(s_spd, v_spd)[0, 1]
        mae_spd = np.mean(np.abs(s_spd - v_spd))
        print(f"\nSpeed Alignment (1:1 row correspondence):")
        print(f"  Correlation between S GPS Speed and VBOX Velocity: {corr_spd:.4f}")
        print(f"  Mean Absolute Error: {mae_spd:.2f} km/h")
        
    # Check yaw rate: S GYROSCOPE vs V Yaw Rate
    # Note: V is in deg/sec, S is in rad/sec
    v_yaw_col = next((c for c in df_v.columns if "YAW RATE" in c.upper()), None)
    s_gyro_yaw_col = next((c for c in df_s.columns if "GYROSCOPE YAW" in c.upper() or "GYROSCOPE (YAW)" in c.upper()), None)
    s_gyro_pitch_col = next((c for c in df_s.columns if "GYROSCOPE PITCH" in c.upper() or "GYROSCOPE (PITCH)" in c.upper()), None)
    s_gyro_roll_col = next((c for c in df_s.columns if "GYROSCOPE ROLL" in c.upper() or "GYROSCOPE (ROLL)" in c.upper()), None)
    
    print(f"\nChecking Gyro / Yaw Rate Alignment:")
    print(f"  V Yaw Rate col: {v_yaw_col}")
    print(f"  S Gyro cols: Yaw={s_gyro_yaw_col}, Pitch={s_gyro_pitch_col}, Roll={s_gyro_roll_col}")
    
    if v_yaw_col:
        v_yaw_deg = df_v[v_yaw_col].values[:min_len].astype(float)
        for s_col, s_name in [(s_gyro_yaw_col, "Yaw"), (s_gyro_pitch_col, "Pitch"), (s_gyro_roll_col, "Roll")]:
            if s_col:
                s_gyro = df_s[s_col].values[:min_len].astype(float) # rad/s
                s_gyro_deg = s_gyro * 180.0 / np.pi
                corr = np.corrcoef(s_gyro_deg, v_yaw_deg)[0, 1]
                print(f"  Correlation between VBOX Yaw Rate and S Gyro {s_name}: {corr:.4f}")

    # Check Accelerometer vs VBOX Longitudinal / Lateral Acceleration
    v_long_acc_col = next((c for c in df_v.columns if "LONGITUDINAL ACCELERATION" in c.upper()), None)
    v_lat_acc_col = next((c for c in df_v.columns if "LATERAL ACCELERATION" in c.upper()), None)
    
    s_acc_x = next((c for c in df_s.columns if "ACCELEROMETER X" in c.upper()), None)
    s_acc_y = next((c for c in df_s.columns if "ACCELEROMETER Y" in c.upper()), None)
    s_acc_z = next((c for c in df_s.columns if "ACCELEROMETER Z" in c.upper()), None)
    s_grav_x = next((c for c in df_s.columns if "GRAVITY X" in c.upper()), None)
    s_grav_y = next((c for c in df_s.columns if "GRAVITY Y" in c.upper()), None)
    s_grav_z = next((c for c in df_s.columns if "GRAVITY Z" in c.upper()), None)
    
    print(f"\nChecking Acceleration Alignment:")
    print(f"  VBOX Long Acc col: {v_long_acc_col}, Lat Acc col: {v_lat_acc_col}")
    print(f"  S Accel cols: X={s_acc_x}, Y={s_acc_y}, Z={s_acc_z}")
    print(f"  S Gravity cols: X={s_grav_x}, Y={s_grav_y}, Z={s_grav_z}")
    
    if v_long_acc_col and s_acc_x and s_acc_y:
        v_long = df_v[v_long_acc_col].values[:min_len].astype(float) * 9.80665 # convert g to m/s^2
        v_lat = df_v[v_lat_acc_col].values[:min_len].astype(float) * 9.80665
        
        # Raw accel
        ax = df_s[s_acc_x].values[:min_len].astype(float)
        ay = df_s[s_acc_y].values[:min_len].astype(float)
        az = df_s[s_acc_z].values[:min_len].astype(float)
        
        # Linear accel (accel - gravity)
        gx = df_s[s_grav_x].values[:min_len].astype(float) if s_grav_x else 0
        gy = df_s[s_grav_y].values[:min_len].astype(float) if s_grav_y else 0
        gz = df_s[s_grav_z].values[:min_len].astype(float) if s_grav_z else 0
        
        lax = ax - gx
        lay = ay - gy
        laz = az - gz
        
        print(f"  Correlation VBOX Long Acc vs S Linear Acc X: {np.corrcoef(v_long, lax)[0, 1]:.4f}")
        print(f"  Correlation VBOX Long Acc vs S Linear Acc Y: {np.corrcoef(v_long, lay)[0, 1]:.4f}")
        print(f"  Correlation VBOX Long Acc vs S Linear Acc Z: {np.corrcoef(v_long, laz)[0, 1]:.4f}")
        print(f"  Correlation VBOX Lat Acc vs S Linear Acc X: {np.corrcoef(v_lat, lax)[0, 1]:.4f}")
        print(f"  Correlation VBOX Lat Acc vs S Linear Acc Y: {np.corrcoef(v_lat, lay)[0, 1]:.4f}")
        print(f"  Correlation VBOX Lat Acc vs S Linear Acc Z: {np.corrcoef(v_lat, laz)[0, 1]:.4f}")
        print(f"  Mean Gravity: gx={np.mean(gx):.3f}, gy={np.mean(gy):.3f}, gz={np.mean(gz):.3f}")

if __name__ == "__main__":
    # Test a few diverse runs
    runs = [
        ("Driver A / S1", r"S (Driver A)\S1\S-S1.csv", r"S (Driver A)\S1\V-S1.csv"),
        ("Driver B / M", r"M (Driver B)\S-M.csv", r"M (Driver B)\V-M.csv"),
        ("Driver E / Vta01a", r"Vta (Driver E)\Vta01a\S-Vta1a.csv", r"Vta (Driver E)\Vta01a\V-Vta1a.csv"),
        ("Driver E / Vw1 (Stationary)", r"Vw (Driver E)\Vw01\S-Vw1.csv", r"Vw (Driver E)\Vw01\V-Vw1.csv"),
    ]
    for name, s_p, v_p in runs:
        analyze_timing_and_sync(name, s_p, v_p)
