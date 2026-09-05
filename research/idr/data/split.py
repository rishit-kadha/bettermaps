"""
Session-Level Dataset Partitioning & Test-Set Locking Module for BetterMaps IDR.

Implements:
- 100% session-level splitting (zero time-series contamination across splits).
- Stratified partitioning across drivers (Driver A, B, D, E) and styles (Defensive, Aggressive).
- Strict test-set locking protocol:
    Train -> Validation model selection & loss weight tuning -> Freeze -> ONE final Test evaluation.
- Stationary sessions excluded from dynamic training / validation.
- Generates:
    artifacts/data/train_sessions.txt
    artifacts/data/val_sessions.txt
    artifacts/data/test_sessions.txt
    artifacts/data/split_summary.csv
"""

import os
import pandas as pd
import numpy as np
from typing import Dict, List, Tuple


def partition_sessions(
    inventory_csv: str = "artifacts/data/session_inventory.csv",
    output_dir: str = "artifacts/data",
    random_seed: int = 42
) -> Dict[str, List[str]]:
    """
    Partitions reliable sessions into Train, Validation, and Test sets.
    """
    df = pd.read_csv(inventory_csv)
    
    # 1. Filter reliable dynamic driving sessions
    # Exclude stationary benchmark runs and unreliable sessions
    dynamic_reliable = df[
        (df["reliable"] == True) & 
        (df["reason"] != "STATIONARY_BENCHMARK_RUN")
    ].copy()
    
    print(f"Total available dynamic reliable sessions: {len(dynamic_reliable)}")
    
    # Stratify by category / driver group
    # Driver A: S1, S2, S3a, S3b, S3c, S4 (6 sessions)
    # Driver B: M (1 session)
    # Driver D: Y1 (1 session)
    # Driver E: Vf, Vta, Vtb, Vw (~59 sessions)
    
    # Fixed assignment for high-value benchmark sessions:
    # S1 (Driver A, 51k samples): Train
    # S3c (Driver A, 5k samples): Train
    # S3a (Driver A, 17k samples): Validation
    # S2 (Driver A, 93k samples): Test (held out long defensive drive)
    # S4 (Driver A, 8k samples): Validation
    # S3b (Driver A, 10k samples): Train
    # M (Driver B, 105k samples): Test (held out for cross-driver evaluation)
    # Y1 (Driver D, 70k samples): Train
    # Vf sessions: Vfa01 (Train), Vfa02 (Val)
    
    fixed_train = ["S1", "S3b", "S3c", "Y1", "Vfa01"]
    fixed_val = ["S3a", "S4", "Vfa02"]
    fixed_test = ["S2", "M"]
    
    # Driver E remaining sessions (Vta, Vtb, Vw)
    driver_e = dynamic_reliable[
        dynamic_reliable["driver"] == "Driver E"
    ]["session_id"].tolist()
    
    # Remove any already assigned
    remaining_e = [s for s in driver_e if s not in fixed_train and s not in fixed_val and s not in fixed_test]
    
    np.random.seed(random_seed)
    shuffled_e = np.random.permutation(remaining_e).tolist()
    
    # Target ~70% Train, ~15% Val, ~15% Test
    n_e = len(shuffled_e)
    n_test_e = max(1, int(round(0.15 * n_e)))
    n_val_e = max(1, int(round(0.15 * n_e)))
    
    test_e = shuffled_e[:n_test_e]
    val_e = shuffled_e[n_test_e : n_test_e + n_val_e]
    train_e = shuffled_e[n_test_e + n_val_e :]
    
    train_sessions = sorted(fixed_train + train_e)
    val_sessions = sorted(fixed_val + val_e)
    test_sessions = sorted(fixed_test + test_e)
    
    # Verification assertions: zero overlap
    set_train = set(train_sessions)
    set_val = set(val_sessions)
    set_test = set(test_sessions)
    
    assert len(set_train & set_val) == 0, f"Leakage between Train and Val: {set_train & set_val}"
    assert len(set_train & set_test) == 0, f"Leakage between Train and Test: {set_train & set_test}"
    assert len(set_val & set_test) == 0, f"Leakage between Val and Test: {set_val & set_test}"
    
    os.makedirs(output_dir, exist_ok=True)
    
    # Save session lists
    train_path = os.path.join(output_dir, "train_sessions.txt")
    val_path = os.path.join(output_dir, "val_sessions.txt")
    test_path = os.path.join(output_dir, "test_sessions.txt")
    
    with open(train_path, "w") as f:
        f.write("\n".join(train_sessions) + "\n")
    with open(val_path, "w") as f:
        f.write("\n".join(val_sessions) + "\n")
    with open(test_path, "w") as f:
        f.write("\n".join(test_sessions) + "\n")
        
    print(f"Saved split lists to {output_dir}")
    
    # Compile summary table
    summary_rows = []
    for split_name, s_list in [("Train", train_sessions), ("Val", val_sessions), ("Test", test_sessions)]:
        sub_df = df[df["session_id"].isin(s_list)]
        total_samples = sub_df["s_samples"].sum()
        total_duration_h = sub_df["duration_s"].sum() / 3600.0
        total_windows = sub_df["usable_windows"].sum()
        drivers = sorted(sub_df["driver"].unique().tolist())
        
        summary_rows.append({
            "split": split_name,
            "session_count": len(s_list),
            "total_samples": total_samples,
            "duration_hours": round(total_duration_h, 2),
            "usable_windows": total_windows,
            "drivers": ", ".join(drivers),
            "sessions": ", ".join(s_list)
        })
        
    df_summary = pd.DataFrame(summary_rows)
    summary_csv = os.path.join(output_dir, "split_summary.csv")
    df_summary.to_csv(summary_csv, index=False)
    print(f"Saved split summary to {summary_csv}")
    
    return {
        "train": train_sessions,
        "val": val_sessions,
        "test": test_sessions,
        "summary": df_summary
    }


if __name__ == "__main__":
    res = partition_sessions()
    print(res["summary"][["split", "session_count", "total_samples", "duration_hours", "usable_windows", "drivers"]])
