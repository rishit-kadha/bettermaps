import os
import sys
import pandas as pd
import numpy as np

sys.stdout.reconfigure(encoding='utf-8')

DATASET_ROOT = r"c:\Users\rkadh\OneDrive\Documents\GitHub\bettermaps\research\IO-VNBD"
SYNC_CAT = os.path.join(DATASET_ROOT, "Synchronised V abd S datasets", "Categorised IOVNB Dataset")

def clean_cols(df):
    df.columns = [c.strip() for c in df.columns]
    return df

def find_best_lag(x, y, max_lag=200):
    # compute cross correlation for lag in [-max_lag, max_lag]
    # positive lag means y is shifted forward relative to x
    lags = range(-max_lag, max_lag + 1)
    corrs = []
    for lag in lags:
        if lag < 0:
            xs = x[:lag]
            ys = y[-lag:]
        elif lag > 0:
            xs = x[lag:]
            ys = y[:-lag]
        else:
            xs = x
            ys = y
        if len(xs) > 10 and np.std(xs) > 1e-5 and np.std(ys) > 1e-5:
            c = np.corrcoef(xs, ys)[0, 1]
        else:
            c = 0.0
        corrs.append(c)
    best_idx = np.argmax(np.abs(corrs))
    return lags[best_idx], corrs[best_idx]

def check_lags_and_axes():
    runs_to_check = [
        ("Driver A / S1", r"S (Driver A)\S1\S-S1.csv", r"S (Driver A)\S1\V-S1.csv"),
        ("Driver A / S2", r"S (Driver A)\S2\S-S2.csv", r"S (Driver A)\S2\V-S2.csv"),
        ("Driver B / M", r"M (Driver B)\S-M.csv", r"M (Driver B)\V-M.csv"),
        ("Driver D / Y1", r"Y (Driver D)\S-Y1.csv", r"Y (Driver D)\V-Y1.csv"),
        ("Driver E / Vf01", r"Vf (Driver E)\S-Vfa01.csv", r"Vf (Driver E)\V-Vfa01.csv"),
        ("Driver E / Vta01a", r"Vta (Driver E)\Vta01a\S-Vta1a.csv", r"Vta (Driver E)\Vta01a\V-Vta1a.csv"),
        ("Driver E / Vta02", r"Vta (Driver E)\Vta02\S-Vta2.csv", r"Vta (Driver E)\Vta02\V-vta2.csv"),
        ("Driver E / Vtb01", r"Vtb (Driver E)\Vtb01\S-Vtb1.csv", r"Vtb (Driver E)\Vtb01\V-vtb1.csv"),
        ("Driver E / Vw02", r"Vw (Driver E)\Vw02\S-Vw2.csv", r"Vw (Driver E)\Vw02\V-Vw2.csv"),
    ]
    
    for name, s_rel, v_rel in runs_to_check:
        s_p = os.path.join(SYNC_CAT, s_rel)
        v_p = os.path.join(SYNC_CAT, v_rel)
        if not os.path.exists(s_p) or not os.path.exists(v_p):
            print(f"Skipping {name}: file not found ({s_p} or {v_p})")
            continue
            
        df_s = clean_cols(pd.read_csv(s_p, encoding='latin1'))
        df_v = clean_cols(pd.read_csv(v_p, encoding='latin1'))
        
        min_len = min(len(df_s), len(df_v))
        print(f"\n--- Checking {name} (length={min_len}) ---")
        
        # Speed lag
        s_spd_col = next((c for c in df_s.columns if "GPS SPEED" in c.upper()), None)
        v_spd_col = next((c for c in df_v.columns if "VELOCITY" in c.upper()), None)
        
        if s_spd_col and v_spd_col:
            s_spd = df_s[s_spd_col].values[:min_len].astype(float)
            v_spd = df_v[v_spd_col].values[:min_len].astype(float)
            lag, corr = find_best_lag(s_spd, v_spd, max_lag=200)
            corr_0 = np.corrcoef(s_spd, v_spd)[0, 1]
            print(f"  Speed correlation at lag 0: {corr_0:.4f}, Best lag: {lag} steps ({lag*0.1:.1f}s) with corr={corr:.4f}")
            
        # Yaw rate lag
        v_yaw_col = next((c for c in df_v.columns if "YAW RATE" in c.upper()), None)
        s_yaw = next((c for c in df_s.columns if "GYROSCOPE YAW" in c.upper() or "GYROSCOPE (YAW)" in c.upper()), None)
        s_pitch = next((c for c in df_s.columns if "GYROSCOPE PITCH" in c.upper() or "GYROSCOPE (PITCH)" in c.upper()), None)
        s_roll = next((c for c in df_s.columns if "GYROSCOPE ROLL" in c.upper() or "GYROSCOPE (ROLL)" in c.upper()), None)
        
        if v_yaw_col:
            v_yaw = df_v[v_yaw_col].values[:min_len].astype(float)
            for s_col, s_name in [(s_yaw, "Yaw"), (s_pitch, "Pitch"), (s_roll, "Roll")]:
                if s_col:
                    s_g = df_s[s_col].values[:min_len].astype(float) * 180.0 / np.pi
                    lag, corr = find_best_lag(s_g, v_yaw, max_lag=50)
                    corr_0 = np.corrcoef(s_g, v_yaw)[0, 1] if np.std(s_g) > 1e-5 and np.std(v_yaw) > 1e-5 else 0.0
                    print(f"  Gyro {s_name:<5} vs VBOX Yaw Rate: lag 0={corr_0:+.4f}, best lag={lag:+d} ({lag*0.1:+.1f}s) corr={corr:+.4f}")

        # Check orientation and gravity means
        gx_col = next((c for c in df_s.columns if "GRAVITY X" in c.upper()), None)
        gy_col = next((c for c in df_s.columns if "GRAVITY Y" in c.upper()), None)
        gz_col = next((c for c in df_s.columns if "GRAVITY Z" in c.upper()), None)
        gx = np.mean(df_s[gx_col].values) if gx_col else 0
        gy = np.mean(df_s[gy_col].values) if gy_col else 0
        gz = np.mean(df_s[gz_col].values) if gz_col else 0
        print(f"  Gravity components mean: X={gx:.3f}, Y={gy:.3f}, Z={gz:.3f}")
        
        # Check phone orientation mean
        oy_col = next((c for c in df_s.columns if "ORIENTATION (YAW)" in c.upper() or "ORIENTATION YAW" in c.upper()), None)
        op_col = next((c for c in df_s.columns if "ORIENTATION (PITCH)" in c.upper() or "ORIENTATION PITCH" in c.upper()), None)
        or_col = next((c for c in df_s.columns if "ORIENTATION (ROLL" in c.upper() or "ORIENTATION ROLL" in c.upper()), None)
        oy = np.mean(df_s[oy_col].values) if oy_col else 0
        op = np.mean(df_s[op_col].values) if op_col else 0
        orr = np.mean(df_s[or_col].values) if or_col else 0
        print(f"  Phone Orientation mean: Yaw={oy:.1f}°, Pitch={op:.1f}°, Roll={orr:.1f}°")

if __name__ == "__main__":
    check_lags_and_axes()

