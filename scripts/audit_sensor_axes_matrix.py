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

def audit_sensor_axes_matrix():
    print("===================================================================")
    print("DETAILED SENSOR AXIS CORRELATION MATRIX WITH VEHICLE CAN/VBOX")
    print("===================================================================")
    
    test_runs = [
        ("Driver A / S1", r"S (Driver A)\S1\S-S1.csv", r"S (Driver A)\S1\V-S1.csv"),
        ("Driver A / S2", r"S (Driver A)\S2\S-S2.csv", r"S (Driver A)\S2\V-S2.csv"),
        ("Driver A / S3a", r"S (Driver A)\S3a\S-S3a.csv", r"S (Driver A)\S3a\V-S3a.csv"),
        ("Driver A / S4", r"S (Driver A)\S4\S-S4.csv", r"S (Driver A)\S4\V-S4.csv"),
        ("Driver B / M", r"M (Driver B)\S-M.csv", r"M (Driver B)\V-M.csv"),
        ("Driver D / Y1", r"Y (Driver D)\Y1\S-Y1.csv", r"Y (Driver D)\Y1\V-Y1.csv"),
        ("Driver E / Vta02", r"Vta (Driver E)\Vta02\S-Vta2.csv", r"Vta (Driver E)\Vta02\V-vta2.csv"),
        ("Driver E / Vw02", r"Vw (Driver E)\Vw02\S-Vw2.csv", r"Vw (Driver E)\Vw02\V-Vw2.csv"),
    ]

    for label, s_rel, v_rel in test_runs:
        s_p = os.path.join(SYNC_CAT, s_rel)
        v_p = os.path.join(SYNC_CAT, v_rel)
        if not os.path.exists(s_p) or not os.path.exists(v_p):
            print(f"\n[!] File not found for {label}")
            continue
            
        df_s = clean_cols(pd.read_csv(s_p, encoding='latin1'))
        df_v = clean_cols(pd.read_csv(v_p, encoding='latin1'))
        n = min(len(df_s), len(df_v))
        
        # Get columns
        # VBOX columns
        v_spd = df_v[[c for c in df_v.columns if "VELOCITY" in c.upper()][0]].values[:n].astype(float)
        v_yaw = df_v[[c for c in df_v.columns if "YAW RATE" in c.upper()][0]].values[:n].astype(float)
        v_steer = df_v[[c for c in df_v.columns if "STEERING ANGLE" in c.upper()][0]].values[:n].astype(float)
        v_long_a = df_v[[c for c in df_v.columns if "LONGITUDINAL ACCELERATION" in c.upper()][0]].values[:n].astype(float)
        v_lat_a = df_v[[c for c in df_v.columns if "LATERAL ACCELERATION" in c.upper()][0]].values[:n].astype(float)
        
        # S columns
        s_ax = df_s.iloc[:n, 9].values.astype(float)
        s_ay = df_s.iloc[:n, 10].values.astype(float)
        s_az = df_s.iloc[:n, 11].values.astype(float)
        
        s_gx = df_s.iloc[:n, 12].values.astype(float)
        s_gy = df_s.iloc[:n, 13].values.astype(float)
        s_gz = df_s.iloc[:n, 14].values.astype(float)
        
        # Linear accel
        s_lax = s_ax - s_gx
        s_lay = s_ay - s_gy
        s_laz = s_az - s_gz
        
        # Gyro
        s_gyr_yaw = df_s.iloc[:n, 15].values.astype(float)
        s_gyr_pitch = df_s.iloc[:n, 16].values.astype(float)
        s_gyr_roll = df_s.iloc[:n, 17].values.astype(float)
        
        print(f"\n=======================================================")
        print(f"RUN: {label} (N={n} samples, {n*0.1/60:.1f} min)")
        print(f"Mean Gravity: Gx={np.mean(s_gx):.3f}, Gy={np.mean(s_gy):.3f}, Gz={np.mean(s_gz):.3f}")
        
        # Compute correlation with VBOX Yaw Rate
        c_gyr_yaw = np.corrcoef(s_gyr_yaw, v_yaw)[0, 1] if np.std(s_gyr_yaw) > 1e-4 else 0
        c_gyr_pitch = np.corrcoef(s_gyr_pitch, v_yaw)[0, 1] if np.std(s_gyr_pitch) > 1e-4 else 0
        c_gyr_roll = np.corrcoef(s_gyr_roll, v_yaw)[0, 1] if np.std(s_gyr_roll) > 1e-4 else 0
        
        print(f"Gyro vs VBOX Yaw Rate: Yaw={c_gyr_yaw:+.4f} | Pitch={c_gyr_pitch:+.4f} | Roll={c_gyr_roll:+.4f}")
        
        # Compute correlation with VBOX Steering Angle
        cs_gyr_yaw = np.corrcoef(s_gyr_yaw, v_steer)[0, 1] if np.std(s_gyr_yaw) > 1e-4 else 0
        cs_gyr_pitch = np.corrcoef(s_gyr_pitch, v_steer)[0, 1] if np.std(s_gyr_pitch) > 1e-4 else 0
        cs_gyr_roll = np.corrcoef(s_gyr_roll, v_steer)[0, 1] if np.std(s_gyr_roll) > 1e-4 else 0
        print(f"Gyro vs Steering Angle: Yaw={cs_gyr_yaw:+.4f} | Pitch={cs_gyr_pitch:+.4f} | Roll={cs_gyr_roll:+.4f}")
        
        # Compute correlation of Linear Accel with VBOX Long Accel
        c_lax_long = np.corrcoef(s_lax, v_long_a)[0, 1] if np.std(s_lax) > 1e-4 else 0
        c_lay_long = np.corrcoef(s_lay, v_long_a)[0, 1] if np.std(s_lay) > 1e-4 else 0
        c_laz_long = np.corrcoef(s_laz, v_long_a)[0, 1] if np.std(s_laz) > 1e-4 else 0
        print(f"Linear Acc vs VBOX Long Accel: Lax={c_lax_long:+.4f} | Lay={c_lay_long:+.4f} | Laz={c_laz_long:+.4f}")

        # Compute correlation of Linear Accel with VBOX Lat Accel
        c_lax_lat = np.corrcoef(s_lax, v_lat_a)[0, 1] if np.std(s_lax) > 1e-4 else 0
        c_lay_lat = np.corrcoef(s_lay, v_lat_a)[0, 1] if np.std(s_lay) > 1e-4 else 0
        c_laz_lat = np.corrcoef(s_laz, v_lat_a)[0, 1] if np.std(s_laz) > 1e-4 else 0
        print(f"Linear Acc vs VBOX Lat Accel:  Lax={c_lax_lat:+.4f} | Lay={c_lay_lat:+.4f} | Laz={c_laz_lat:+.4f}")

if __name__ == "__main__":
    audit_sensor_axes_matrix()

