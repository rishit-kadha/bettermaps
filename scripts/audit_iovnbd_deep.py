import os
import glob
import csv
import sys
import zipfile

sys.stdout.reconfigure(encoding='utf-8')

DATASET_ROOT = r"c:\Users\rkadh\OneDrive\Documents\GitHub\bettermaps\research\IO-VNBD"

def inspect_all():
    print("--- Checking Zip Files ---")
    zips = [f for f in os.listdir(DATASET_ROOT) if f.endswith(".zip")]
    for z in zips:
        zpath = os.path.join(DATASET_ROOT, z)
        with zipfile.ZipFile(zpath, 'r') as zf:
            nl = zf.namelist()
            print(f"Zip: {z} contains {len(nl)} entries, size={os.path.getsize(zpath)/(1024*1024):.2f} MB")
            print(f"  Sample entries: {nl[:3]}")

    print("\n--- Inspecting Uncategorised Synchronised Dataset ---")
    uncat_sync = os.path.join(DATASET_ROOT, "Synchronised V abd S datasets", "Uncategorised IOVNB Dataset")
    for sub in os.listdir(uncat_sync):
        subpath = os.path.join(uncat_sync, sub)
        if os.path.isdir(subpath):
            files = os.listdir(subpath)
            csvs = [f for f in files if f.endswith(".csv")]
            print(f"  {sub}: {len(files)} files ({len(csvs)} CSVs)")
            print(f"    Sample: {csvs[:4]}")

    print("\n--- Inspecting Unsynchronised Datasets ---")
    unsync_cat = os.path.join(DATASET_ROOT, "Unsynchronised V and S Dataset", "Categorised IOVNB (V) Dataset")
    if os.path.exists(unsync_cat):
        for sub in os.listdir(unsync_cat):
            subpath = os.path.join(unsync_cat, sub)
            if os.path.isdir(subpath):
                files = os.listdir(subpath)
                csvs = [f for f in files if f.endswith(".csv")]
                print(f"  Categorised Unsync: {sub}: {len(files)} files ({len(csvs)} CSVs)")
    
    unsync_uncat = os.path.join(DATASET_ROOT, "Unsynchronised V and S Dataset", "Uncategorised IOVNB (V and S) Dataset")
    if os.path.exists(unsync_uncat):
        for sub in os.listdir(unsync_uncat):
            subpath = os.path.join(unsync_uncat, sub)
            if os.path.isdir(subpath):
                files = os.listdir(subpath)
                csvs = [f for f in files if f.endswith(".csv")]
                print(f"  Uncategorised Unsync: {sub}: {len(files)} files ({len(csvs)} CSVs)")

    print("\n--- Inspecting Headers of S and V files ---")
    # Let's inspect a sample S and V file from Driver A (S1)
    s_s1_path = os.path.join(DATASET_ROOT, "Synchronised V abd S datasets", "Categorised IOVNB Dataset", "S (Driver A)", "S1", "S-S1.csv")
    v_s1_path = os.path.join(DATASET_ROOT, "Synchronised V abd S datasets", "Categorised IOVNB Dataset", "S (Driver A)", "S1", "V-S1.csv")

    with open(s_s1_path, 'r', encoding='utf-8', errors='ignore') as f:
        r = csv.reader(f)
        s_header = next(r)
        s_row1 = next(r)
        s_row2 = next(r)

    with open(v_s1_path, 'r', encoding='utf-8', errors='ignore') as f:
        r = csv.reader(f)
        v_header = next(r)
        v_row1 = next(r)
        v_row2 = next(r)

    print(f"S-S1 Header ({len(s_header)} cols):")
    for i, col in enumerate(s_header):
        print(f"  [{i:02d}] {col} | sample: {s_row1[i] if i < len(s_row1) else 'N/A'}")

    print(f"\nV-S1 Header ({len(v_header)} cols):")
    for i, col in enumerate(v_header):
        print(f"  [{i:02d}] {col} | sample: {v_row1[i] if i < len(v_row1) else 'N/A'}")

if __name__ == "__main__":
    inspect_all()
