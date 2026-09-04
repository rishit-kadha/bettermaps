import os
import csv
import sys
import pandas as pd
import numpy as np

sys.stdout.reconfigure(encoding='utf-8')

DATASET_ROOT = r"c:\Users\rkadh\OneDrive\Documents\GitHub\bettermaps\research\IO-VNBD"
SYNC_CAT = os.path.join(DATASET_ROOT, "Synchronised V abd S datasets", "Categorised IOVNB Dataset")

def inspect_column_names_and_time():
    # Let's inspect column names across different drivers
    sample_files = [
        ("Driver A / S1", os.path.join(SYNC_CAT, "S (Driver A)", "S1", "S-S1.csv")),
        ("Driver B / M", os.path.join(SYNC_CAT, "M (Driver B)", "S-M.csv")),
        ("Driver D / Y1", os.path.join(SYNC_CAT, "Y (Driver D)", "S-Y1.csv")),
        ("Driver E / Vf", os.path.join(SYNC_CAT, "Vf (Driver E)", "S-Vfa01.csv")),
        ("Driver E / Vta", os.path.join(SYNC_CAT, "Vta (Driver E)", "S-Vta01a.csv")),
        ("Driver E / Vtb", os.path.join(SYNC_CAT, "Vtb (Driver E)", "S-Vtb01.csv")),
        ("Driver E / Vw", os.path.join(SYNC_CAT, "Vw (Driver E)", "S-Vw01.csv")),
    ]
    
    print("--- S File Column Names Across Drivers ---")
    for label, path in sample_files:
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                r = csv.reader(f)
                header = [c.strip() for c in next(r)]
            print(f"{label}: {len(header)} cols -> {header[:5]} ... {header[-3:]}")

    # Let's check V file columns
    sample_v_files = [
        ("Driver A / S1", os.path.join(SYNC_CAT, "S (Driver A)", "S1", "V-S1.csv")),
        ("Driver B / M", os.path.join(SYNC_CAT, "M (Driver B)", "V-M.csv")),
        ("Driver D / Y1", os.path.join(SYNC_CAT, "Y (Driver D)", "V-Y1.csv")),
        ("Driver E / Vf", os.path.join(SYNC_CAT, "Vf (Driver E)", "V-Vfa01.csv")),
        ("Driver E / Vta", os.path.join(SYNC_CAT, "Vta (Driver E)", "V-Vta01a.csv")),
        ("Driver E / Vtb", os.path.join(SYNC_CAT, "Vtb (Driver E)", "V-vtb1.csv")),
        ("Driver E / Vw", os.path.join(SYNC_CAT, "Vw (Driver E)", "V-Vw1.csv")),
    ]
    print("\n--- V File Column Names Across Drivers ---")
    for label, path in sample_v_files:
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                r = csv.reader(f)
                header = [c.strip() for c in next(r)]
            print(f"{label}: {len(header)} cols -> {header[:5]} ... {header[-3:]}")

if __name__ == "__main__":
    inspect_column_names_and_time()

