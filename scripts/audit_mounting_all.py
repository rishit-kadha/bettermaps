import os
import sys
import pandas as pd
import numpy as np

sys.stdout.reconfigure(encoding='utf-8')

DATASET_ROOT = r"c:\Users\rkadh\OneDrive\Documents\GitHub\bettermaps\research\IO-VNBD"
SYNC_CAT = os.path.join(DATASET_ROOT, "Synchronised V abd S datasets", "Categorised IOVNB Dataset")

def clean_cols(df):
    clean = []
    for c in df.columns:
        ascii_c = ''.join(ch for ch in c if ord(ch) < 128).strip()
        ascii_c = ' '.join(ascii_c.split())
        clean.append(ascii_c)
    df.columns = clean
    return df

def audit_gravity_and_mounting():
    print("=========================================================================")
    print("INSPECTING GRAVITY VECTOR AND MOUNTING ACROSS ALL RUNS")
    print("=========================================================================")
    
    categories = os.listdir(SYNC_CAT)
    runs = []
    
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
                if sf:
                    runs.append((f"{cat}/{sdir}", os.path.join(run_dir, sf)))
        else:
            csvs = [f for f in os.listdir(cat_dir) if f.endswith(".csv")]
            s_files = [f for f in csvs if f.startswith("S-") or f.startswith("s-")]
            for sf in sorted(s_files):
                runs.append((f"{cat}/{sf}", os.path.join(cat_dir, sf)))

    print(f"Total S runs found: {len(runs)}")
    
    grav_results = []
    for name, sp in runs:
        try:
            df = clean_cols(pd.read_csv(sp, encoding='latin1', nrows=1000))
            
            # Check gravity cols
            gx_col = [c for c in df.columns if "GRAVITY" in c.upper() and "X" in c.upper()][0]
            gy_col = [c for c in df.columns if "GRAVITY" in c.upper() and "Y" in c.upper()][0]
            gz_col = [c for c in df.columns if "GRAVITY" in c.upper() and "Z" in c.upper()][0]
            
            gx = np.mean(df[gx_col].values.astype(float))
            gy = np.mean(df[gy_col].values.astype(float))
            gz = np.mean(df[gz_col].values.astype(float))
            
            # Check orientation pitch & roll
            op_col = [c for c in df.columns if "ORIENTATION" in c.upper() and "PITCH" in c.upper()][0]
            or_col = [c for c in df.columns if "ORIENTATION" in c.upper() and "ROLL" in c.upper()][0]
            op = np.mean(df[op_col].values.astype(float))
            orr = np.mean(df[or_col].values.astype(float))
            
            grav_results.append({
                "name": name,
                "gx": gx, "gy": gy, "gz": gz,
                "pitch": op, "roll": orr
            })
        except Exception as e:
            print(f"Error reading {name}: {e}")

    df_res = pd.DataFrame(grav_results)
    print(f"\nGravity Summary Across All {len(df_res)} Runs:")
    print(f"  Mean Gx: {df_res['gx'].mean():.4f} m/s^2 (min: {df_res['gx'].min():.3f}, max: {df_res['gx'].max():.3f})")
    print(f"  Mean Gy: {df_res['gy'].mean():.4f} m/s^2 (min: {df_res['gy'].min():.3f}, max: {df_res['gy'].max():.3f})")
    print(f"  Mean Gz: {df_res['gz'].mean():.4f} m/s^2 (min: {df_res['gz'].min():.3f}, max: {df_res['gz'].max():.3f})")
    print(f"  Mean Orientation Pitch: {df_res['pitch'].mean():.1f}° (min: {df_res['pitch'].min():.1f}°, max: {df_res['pitch'].max():.1f}°)")
    print(f"  Mean Orientation Roll:  {df_res['roll'].mean():.1f}° (min: {df_res['roll'].min():.1f}°, max: {df_res['roll'].max():.1f}°)")
    
    # Print sample of runs
    print("\nSample Runs:")
    for _, row in df_res.iloc[::8].iterrows():
        print(f"  {row['name']:<25} | G=[{row['gx']:+.2f}, {row['gy']:+.2f}, {row['gz']:+.2f}] | Pitch={row['pitch']:+.1f}°, Roll={row['roll']:+.1f}°")

if __name__ == "__main__":
    audit_gravity_and_mounting()

