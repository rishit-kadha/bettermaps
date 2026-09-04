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

def find_global_lag(s_spd, v_spd, max_lag_s=60, step=1):
    # compute correlation for lag in steps of 0.1s
    max_lag_steps = int(max_lag_s * 10)
    lags = range(-max_lag_steps, max_lag_steps + 1, step)
    best_lag = 0
    best_corr = -1.0
    
    # Subsample if too large for speed
    n = min(len(s_spd), len(v_spd))
    s = s_spd[:n]
    v = v_spd[:n]
    
    for lag in lags:
        if lag < 0:
            xs = s[:lag]
            ys = v[-lag:]
        elif lag > 0:
            xs = s[lag:]
            ys = v[:-lag]
        else:
            xs = s
            ys = v
        if len(xs) > 100 and np.std(xs) > 0.5 and np.std(ys) > 0.5:
            c = np.corrcoef(xs, ys)[0, 1]
            if c > best_corr:
                best_corr = c
                best_lag = lag
                
    return best_lag, best_corr

def scan_all_sync_runs_for_time_offset():
    print("=========================================================================")
    print("SCANNING SYNCHRONIZED RUNS FOR CLOCK OFFSETS (TIME LAG)")
    print("=========================================================================")
    
    categories = os.listdir(SYNC_CAT)
    records = []
    
    for cat in sorted(categories):
        cat_dir = os.path.join(SYNC_CAT, cat)
        if not os.path.isdir(cat_dir):
            continue
            
        subdirs = [e for e in os.listdir(cat_dir) if os.path.isdir(os.path.join(cat_dir, e))]
        if subdirs:
            for sdir in sorted(subdirs):
                run_dir = os.path.join(cat_dir, sdir)
                csvs = [f for f in os.listdir(run_dir) if f.endswith(".csv")]
                sf = next((f for f in csvs if f.startswith("S-") or f.startswith("s-")), None)
                vf = next((f for f in csvs if f.startswith("V-") or f.startswith("v-")), None)
                if sf and vf:
                    records.append((f"{cat}/{sdir}", os.path.join(run_dir, sf), os.path.join(run_dir, vf)))
        else:
            csvs = [f for f in os.listdir(cat_dir) if f.endswith(".csv")]
            s_files = [f for f in csvs if f.startswith("S-") or f.startswith("s-")]
            for sf in sorted(s_files):
                base = sf[2:-4]
                vf = next((f for f in csvs if (f.startswith("V-") or f.startswith("v-")) and base.lower() in f.lower()), None)
                if vf:
                    records.append((f"{cat}/{base}", os.path.join(cat_dir, sf), os.path.join(cat_dir, vf)))

    print(f"Total synchronized runs to evaluate: {len(records)}")
    
    # Audit a representative set across all categories
    selected = [r for r in records if any(k in r[0] for k in ['S1', 'S2', 'S3a', 'S3c', 'S4', 'M', 'Y1', 'Vta01a', 'Vta02', 'Vta10', 'Vta20', 'Vtb01', 'Vtb05', 'Vw01', 'Vw02', 'Vw04', 'Vw14b', 'Vfa01', 'Vfa02'])]
    
    print(f"\n{'Run':<20} | {'Rows':<7} | {'Lag 0 Corr':<10} | {'Best Lag (s)':<12} | {'Best Corr':<10} | {'Pitch-Yaw Corr @ Best Lag':<25}")
    print("-" * 95)
    
    for name, sp, vp in selected:
        try:
            df_s = clean_cols(pd.read_csv(sp, encoding='latin1'))
            df_v = clean_cols(pd.read_csv(vp, encoding='latin1'))
            n = min(len(df_s), len(df_v))
            
            s_spd_col = [c for c in df_s.columns if "GPS SPEED" in c.upper()][0]
            v_spd_col = [c for c in df_v.columns if "VELOCITY" in c.upper()][0]
            
            s_spd = df_s[s_spd_col].values[:n].astype(float)
            v_spd = df_v[v_spd_col].values[:n].astype(float)
            
            # Check stationary runs (like Vw01)
            if np.std(v_spd) < 0.1:
                print(f"{name:<20} | {n:<7} | {'STATIONARY':<10} | {'0.0':<12} | {'N/A':<10} | {'N/A':<25}")
                continue
                
            c0 = np.corrcoef(s_spd, v_spd)[0, 1]
            best_lag, best_corr = find_global_lag(s_spd, v_spd, max_lag_s=30, step=1)
            
            # Now compute Gyro Pitch vs VBOX Yaw Rate at best_lag
            s_pitch_col = [c for c in df_s.columns if "GYROSCOPE PITCH" in c.upper() or "GYROSCOPE (PITCH)" in c.upper()][0]
            v_yaw_col = [c for c in df_v.columns if "YAW RATE" in c.upper()][0]
            
            s_pitch = df_s[s_pitch_col].values[:n].astype(float)
            v_yaw = df_v[v_yaw_col].values[:n].astype(float)
            
            if best_lag < 0:
                s_p_aligned = s_pitch[:best_lag]
                v_y_aligned = v_yaw[-best_lag:]
            elif best_lag > 0:
                s_p_aligned = s_pitch[best_lag:]
                v_y_aligned = v_yaw[:-best_lag]
            else:
                s_p_aligned = s_pitch
                v_y_aligned = v_yaw
                
            c_gyro = np.corrcoef(s_p_aligned, v_y_aligned)[0, 1] if len(s_p_aligned) > 50 and np.std(s_p_aligned) > 1e-4 else 0.0
            
            print(f"{name:<20} | {n:<7} | {c0:<10.4f} | {best_lag*0.1:<+12.1f} | {best_corr:<10.4f} | {c_gyro:<+25.4f}")
        except Exception as e:
            print(f"{name:<20} | ERROR: {e}")

if __name__ == "__main__":
    scan_all_sync_runs_for_time_offset()

