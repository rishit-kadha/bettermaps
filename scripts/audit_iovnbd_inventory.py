import os
import glob
import csv
import json

DATASET_ROOT = r"c:\Users\rkadh\OneDrive\Documents\GitHub\bettermaps\research\IO-VNBD"

def scan_dataset():
    print(f"Scanning {DATASET_ROOT}...")
    all_files = []
    for root, dirs, files in os.walk(DATASET_ROOT):
        if ".git" in root:
            continue
        for f in files:
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, DATASET_ROOT)
            size = os.path.getsize(full_path)
            all_files.append((rel_path, size))

    print(f"Total non-git files found: {len(all_files)}")
    
    # Categorize files
    sync_cat_files = [f for f in all_files if f[0].startswith("Synchronised V abd S datasets\\Categorised IOVNB Dataset")]
    sync_uncat_files = [f for f in all_files if f[0].startswith("Synchronised V abd S datasets\\Uncategorised IOVNB Dataset")]
    unsync_cat_files = [f for f in all_files if f[0].startswith("Unsynchronised V and S Dataset\\Categorised IOVNB (V) Dataset")]
    unsync_uncat_files = [f for f in all_files if f[0].startswith("Unsynchronised V and S Dataset\\Uncategorised IOVNB (V and S) Dataset")]
    other_files = [f for f in all_files if not (f[0].startswith("Synchronised") or f[0].startswith("Unsynchronised"))]

    print(f"Synchronised Categorised files: {len(sync_cat_files)}")
    print(f"Synchronised Uncategorised files: {len(sync_uncat_files)}")
    print(f"Unsynchronised Categorised files: {len(unsync_cat_files)}")
    print(f"Unsynchronised Uncategorised files: {len(unsync_uncat_files)}")
    print(f"Other root files: {len(other_files)}")

    # Let's inspect unique drivers/folders in Synchronised Categorised
    drivers = set()
    for rel, size in sync_cat_files:
        parts = rel.split("\\")
        if len(parts) > 2:
            drivers.add(parts[2])
    print("\nDrivers/Categories in Synchronised Categorised:", sorted(list(drivers)))

    # For each driver/category, list subfolders or files
    print("\nDetailed Breakdown of Synchronised Categorised:")
    cat_structure = {}
    for rel, size in sync_cat_files:
        parts = rel.split("\\")
        driver = parts[2]
        cat_structure.setdefault(driver, []).append((rel, size))
    
    for driver, items in sorted(cat_structure.items()):
        total_size_mb = sum(s for _, s in items) / (1024 * 1024)
        csvs = [it for it in items if it[0].endswith(".csv")]
        print(f"  {driver}: {len(items)} files ({len(csvs)} CSVs), {total_size_mb:.2f} MB")
        for r, s in items[:4]:
            print(f"    - {os.path.basename(r)} ({s/1024:.1f} KB)")
        if len(items) > 4:
            print(f"    ... and {len(items)-4} more files")

if __name__ == "__main__":
    scan_dataset()

