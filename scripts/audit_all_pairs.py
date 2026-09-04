import os
import glob
import csv
import sys
import pandas as pd
import numpy as np

sys.stdout.reconfigure(encoding='utf-8')

DATASET_ROOT = r"c:\Users\rkadh\OneDrive\Documents\GitHub\bettermaps\research\IO-VNBD"
SYNC_CAT = os.path.join(DATASET_ROOT, "Synchronised V abd S datasets", "Categorised IOVNB Dataset")

def audit_synchronized_pairs():
    print("=================================================================")
    print("AUDITING ALL SYNCHRONIZED RUNS IN CATEGORISED IOVNB DATASET")
    print("=================================================================")
    
    pair_records = []
    
    # Traverse through all categories
    categories = os.listdir(SYNC_CAT)
    for cat in sorted(categories):
        cat_dir = os.path.join(SYNC_CAT, cat)
        if not os.path.isdir(cat_dir):
            continue
            
        # Check if files are directly inside or in subfolders
        entries = os.listdir(cat_dir)
        subdirs = [e for e in entries if os.path.isdir(os.path.join(cat_dir, e))]
        
        if subdirs:
            # e.g. S (Driver A)/S1
            for sdir in sorted(subdirs):
                run_dir = os.path.join(cat_dir, sdir)
                csvs = [f for f in os.listdir(run_dir) if f.endswith(".csv")]
                s_file = next((f for f in csvs if f.startswith("S-") or f.startswith("s-")), None)
                v_file = next((f for f in csvs if f.startswith("V-") or f.startswith("v-")), None)
                jpg_file = next((f for f in os.listdir(run_dir) if f.lower().endswith(".jpg")), None)
                pair_records.append({
                    "category": cat,
                    "run_id": sdir,
                    "dir": run_dir,
                    "s_file": s_file,
                    "v_file": v_file,
                    "jpg_file": jpg_file
                })
        else:
            # Files directly in cat_dir, e.g. M (Driver B)
            csvs = [f for f in entries if f.endswith(".csv")]
            # find matching pairs
            # Usually S-*.csv and V-*.csv
            s_files = [f for f in csvs if f.startswith("S-") or f.startswith("s-")]
            v_files = [f for f in csvs if f.startswith("V-") or f.startswith("v-")]
            # Match by root name
            for sf in sorted(s_files):
                base = sf[2:-4] # strip 'S-' and '.csv'
                vf = next((v for v in v_files if v[2:-4].lower() == base.lower()), None)
                jpg = next((j for j in entries if j.lower().endswith(".jpg") and base.lower() in j.lower()), None)
                pair_records.append({
                    "category": cat,
                    "run_id": base,
                    "dir": cat_dir,
                    "s_file": sf,
                    "v_file": vf,
                    "jpg_file": jpg
                })

    print(f"Total synchronized run pairs found: {len(pair_records)}")
    
    # Audit each pair
    results = []
    for p in pair_records:
        cat = p["category"]
        run_id = p["run_id"]
        s_path = os.path.join(p["dir"], p["s_file"]) if p["s_file"] else None
        v_path = os.path.join(p["dir"], p["v_file"]) if p["v_file"] else None
        
        s_rows = 0
        v_rows = 0
        s_duration_sec = 0.0
        v_duration_sec = 0.0
        row_diff = 0
        
        if s_path and os.path.exists(s_path):
            with open(s_path, 'r', encoding='utf-8', errors='ignore') as f:
                s_rows = sum(1 for _ in f) - 1 # header
        
        if v_path and os.path.exists(v_path):
            with open(v_path, 'r', encoding='utf-8', errors='ignore') as f:
                v_rows = sum(1 for _ in f) - 1 # header
                
        row_diff = s_rows - v_rows
        
        # Read small sample to compute duration and sampling rate
        s_dt_stats = None
        v_dt_stats = None
        if s_path and s_rows > 1:
            try:
                # read first and last row
                df_s_head = pd.read_csv(s_path, nrows=5)
                # find time col
                time_col = [c for c in df_s_head.columns if "TIME SINCE START" in c.upper()]
                if time_col:
                    t_col = time_col[0]
                    # read entire time col
                    s_t = pd.read_csv(s_path, usecols=[t_col])[t_col].values
                    # check if in ms
                    s_diff = np.diff(s_t)
                    s_dt_stats = {
                        "mean_dt_ms": float(np.mean(s_diff)),
                        "median_dt_ms": float(np.median(s_diff)),
                        "std_dt_ms": float(np.std(s_diff)),
                        "min_dt_ms": float(np.min(s_diff)),
                        "max_dt_ms": float(np.max(s_diff)),
                        "duration_s": float((s_t[-1] - s_t[0]) / 1000.0)
                    }
            except Exception as e:
                print(f"Error reading S time for {run_id}: {e}")
                
        if v_path and v_rows > 1:
            try:
                df_v_head = pd.read_csv(v_path, nrows=5)
                time_col = [c for c in df_v_head.columns if "TIME SINCE START OF DAY" in c.upper()]
                if time_col:
                    t_col = time_col[0]
                    v_t = pd.read_csv(v_path, usecols=[t_col])[t_col].values
                    v_diff = np.diff(v_t)
                    v_dt_stats = {
                        "mean_dt_s": float(np.mean(v_diff)),
                        "median_dt_s": float(np.median(v_diff)),
                        "std_dt_s": float(np.std(v_diff)),
                        "min_dt_s": float(np.min(v_diff)),
                        "max_dt_s": float(np.max(v_diff)),
                        "duration_s": float(v_t[-1] - v_t[0])
                    }
            except Exception as e:
                print(f"Error reading V time for {run_id}: {e}")

        results.append({
            "category": cat,
            "run_id": run_id,
            "s_rows": s_rows,
            "v_rows": v_rows,
            "row_diff": row_diff,
            "s_dt": s_dt_stats,
            "v_dt": v_dt_stats,
            "has_jpg": p["jpg_file"] is not None
        })
        
    print(f"\n{'Category':<15} | {'Run':<8} | {'S-Rows':<7} | {'V-Rows':<7} | {'Diff':<5} | {'S-Dur(s)':<8} | {'V-Dur(s)':<8} | {'S mean dt(ms)':<13} | {'V mean dt(s)':<12}")
    print("-" * 95)
    for r in results:
        s_dur = f"{r['s_dt']['duration_s']:.1f}" if r['s_dt'] else "N/A"
        v_dur = f"{r['v_dt']['duration_s']:.1f}" if r['v_dt'] else "N/A"
        s_dt = f"{r['s_dt']['mean_dt_ms']:.1f}" if r['s_dt'] else "N/A"
        v_dt = f"{r['v_dt']['mean_dt_s']:.3f}" if r['v_dt'] else "N/A"
        print(f"{r['category']:<15} | {r['run_id']:<8} | {r['s_rows']:<7} | {r['v_rows']:<7} | {r['row_diff']:<5} | {s_dur:<8} | {v_dur:<8} | {s_dt:<13} | {v_dt:<12}")

    # Summary aggregations
    total_s_rows = sum(r['s_rows'] for r in results)
    total_v_rows = sum(r['v_rows'] for r in results)
    identical_row_counts = sum(1 for r in results if r['row_diff'] == 0)
    print("\n--- Summary Statistics ---")
    print(f"Total synchronized runs: {len(results)}")
    print(f"Total S rows: {total_s_rows:,}")
    print(f"Total V rows: {total_v_rows:,}")
    print(f"Runs with EXACTLY identical row counts (row_diff == 0): {identical_row_counts} / {len(results)}")
    non_identical = [r for r in results if r['row_diff'] != 0]
    if non_identical:
        print(f"Runs with non-zero row diff:")
        for r in non_identical:
            print(f"  {r['category']} - {r['run_id']}: S={r['s_rows']}, V={r['v_rows']}, Diff={r['row_diff']}")
            
if __name__ == "__main__":
    audit_synchronized_pairs()

