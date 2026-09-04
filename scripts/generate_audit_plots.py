import os
import sys
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

sys.stdout.reconfigure(encoding='utf-8')

DATASET_ROOT = r"c:\Users\rkadh\OneDrive\Documents\GitHub\bettermaps\research\IO-VNBD"
SYNC_CAT = os.path.join(DATASET_ROOT, "Synchronised V abd S datasets", "Categorised IOVNB Dataset")
PLOTS_DIR = r"c:\Users\rkadh\OneDrive\Documents\GitHub\bettermaps\research\plots"
os.makedirs(PLOTS_DIR, exist_ok=True)

def clean_cols(df):
    clean = []
    for c in df.columns:
        ascii_c = ''.join(ch for ch in c if ord(ch) < 128).strip()
        ascii_c = ' '.join(ascii_c.split())
        clean.append(ascii_c)
    df.columns = clean
    return df

def get_col(df, *keywords):
    for c in df.columns:
        if all(k.upper() in c.upper() for k in keywords):
            return df[c].values
    raise KeyError(f"Could not find column matching keywords {keywords} in {list(df.columns)}")

def generate_fig1_sampling():
    print("Generating Fig 1: Sampling Rate Distribution...")
    s1_path = os.path.join(SYNC_CAT, "S (Driver A)", "S1", "S-S1.csv")
    v1_path = os.path.join(SYNC_CAT, "S (Driver A)", "S1", "V-S1.csv")
    
    df_s = clean_cols(pd.read_csv(s1_path, encoding='latin1', nrows=10000))
    df_v = clean_cols(pd.read_csv(v1_path, encoding='latin1', nrows=10000))
    
    t_s = get_col(df_s, 'TIME SINCE START').astype(float)
    dt_s = np.diff(t_s)
    
    t_v = get_col(df_v, 'TIME SINCE START OF DAY').astype(float)
    dt_v = np.diff(t_v) * 1000.0 # to ms
    
    # S GPS update intervals
    gps_spd = get_col(df_s, 'GPS SPEED')
    changes = np.where(np.diff(gps_spd) != 0)[0]
    dt_gps = np.diff(changes) * 100.0 # ms
    
    fig, axes = plt.subplots(1, 3, figsize=(15, 4.5))
    
    # S IMU dt
    axes[0].hist(dt_s, bins=np.linspace(80, 120, 41), color='#1f77b4', edgecolor='black', alpha=0.7)
    axes[0].axvline(np.mean(dt_s), color='red', linestyle='--', label=f'Mean: {np.mean(dt_s):.1f} ms')
    axes[0].axvline(100.0, color='green', linestyle=':', label='Target: 100 ms (10 Hz)')
    axes[0].set_title(r'Smartphone AndroSensor IMU $\Delta t$ (ms)')
    axes[0].set_xlabel(r'$\Delta t$ (ms)')
    axes[0].set_ylabel('Count')
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)
    
    # V CAN dt
    axes[1].hist(dt_v, bins=np.linspace(95, 105, 41), color='#2ca02c', edgecolor='black', alpha=0.7)
    axes[1].axvline(np.mean(dt_v), color='red', linestyle='--', label=f'Mean: {np.mean(dt_v):.2f} ms')
    axes[1].set_title(r'Vehicle VBOX CAN Bus $\Delta t$ (ms)')
    axes[1].set_xlabel(r'$\Delta t$ (ms)')
    axes[1].set_ylabel('Count')
    axes[1].legend()
    axes[1].grid(True, alpha=0.3)
    
    # S GPS update intervals
    axes[2].hist(dt_gps, bins=np.linspace(0, 3000, 31), color='#ff7f0e', edgecolor='black', alpha=0.7)
    axes[2].axvline(np.mean(dt_gps), color='red', linestyle='--', label=f'Mean: {np.mean(dt_gps):.0f} ms')
    axes[2].set_title('Smartphone GPS Update Latency (ms)')
    axes[2].set_xlabel('Latency between value changes (ms)')
    axes[2].set_ylabel('Count')
    axes[2].legend()
    axes[2].grid(True, alpha=0.3)
    
    plt.tight_layout()
    out_path = os.path.join(PLOTS_DIR, "fig1_sampling_rate_distribution.png")
    plt.savefig(out_path, dpi=200)
    plt.close()
    print(f"Saved: {out_path}")

def generate_fig2_sync_s1():
    print("Generating Fig 2: Sync and Signal Alignment (S1)...")
    s1_path = os.path.join(SYNC_CAT, "S (Driver A)", "S1", "S-S1.csv")
    v1_path = os.path.join(SYNC_CAT, "S (Driver A)", "S1", "V-S1.csv")
    
    start_idx = 1000
    n_samples = 3000
    df_s = clean_cols(pd.read_csv(s1_path, encoding='latin1', skiprows=range(1, start_idx), nrows=n_samples))
    df_v = clean_cols(pd.read_csv(v1_path, encoding='latin1', skiprows=range(1, start_idx), nrows=n_samples))
    
    t_rel = np.arange(n_samples) * 0.1 # seconds
    
    fig, axes = plt.subplots(3, 1, figsize=(14, 9), sharex=True)
    
    # Speed
    v_spd = get_col(df_v, 'VELOCITY')
    s_spd = get_col(df_s, 'GPS SPEED')
    axes[0].plot(t_rel, v_spd, label='VBOX CAN Speed (km/h)', color='#2ca02c', linewidth=1.5)
    axes[0].plot(t_rel, s_spd, label='Smartphone GPS Speed (km/h)', color='#d62728', linestyle='--', alpha=0.85)
    axes[0].set_ylabel('Speed (km/h)')
    axes[0].set_title('Run S1: Speed Comparison (Vehicle CAN vs Smartphone GPS)')
    axes[0].legend(loc='upper right')
    axes[0].grid(True, alpha=0.3)
    
    # Yaw rate: VBOX Yaw Rate vs S Gyroscope Pitch (rad/s -> deg/s)
    v_yaw = get_col(df_v, 'YAW RATE')
    s_pitch_deg = get_col(df_s, 'GYROSCOPE', 'PITCH') * 180.0 / np.pi
    axes[1].plot(t_rel, v_yaw, label='VBOX Yaw Rate (deg/s)', color='#2ca02c', linewidth=1.2)
    axes[1].plot(t_rel, s_pitch_deg, label='Smartphone Gyro Pitch (deg/s) [Vertical Axis]', color='#1f77b4', alpha=0.8)
    axes[1].set_ylabel('Yaw Rate (deg/s)')
    axes[1].set_title('Run S1: Rotational Velocity (Vehicle Yaw Rate vs Smartphone Gyroscope)')
    axes[1].legend(loc='upper right')
    axes[1].grid(True, alpha=0.3)
    
    # Acceleration
    v_long_acc = get_col(df_v, 'LONGITUDINAL ACCELERATION') * 9.80665
    s_ax = get_col(df_s, 'ACCELEROMETER', 'X') - get_col(df_s, 'GRAVITY', 'X')
    s_ay = get_col(df_s, 'ACCELEROMETER', 'Y') - get_col(df_s, 'GRAVITY', 'Y')
    axes[2].plot(t_rel, v_long_acc, label='VBOX Longitudinal Accel ($m/s^2$)', color='#2ca02c', linewidth=1.5)
    axes[2].plot(t_rel, s_ax, label='Smartphone Linear Accel X ($m/s^2$)', color='#9467bd', alpha=0.5, linewidth=0.8)
    axes[2].plot(t_rel, s_ay, label='Smartphone Linear Accel Y ($m/s^2$)', color='#ff7f0e', alpha=0.5, linewidth=0.8)
    axes[2].set_ylabel(r'Acceleration ($m/s^2$)')
    axes[2].set_xlabel('Elapsed Time (seconds)')
    axes[2].set_title('Run S1: Acceleration Signals (Vehicle Long Accel vs Phone Linear Accel)')
    axes[2].legend(loc='upper right')
    axes[2].grid(True, alpha=0.3)
    
    plt.tight_layout()
    out_path = os.path.join(PLOTS_DIR, "fig2_synchronization_alignment_s1.png")
    plt.savefig(out_path, dpi=200)
    plt.close()
    print(f"Saved: {out_path}")

def generate_fig3_stationary_vw1():
    print("Generating Fig 3: Stationary Noise Floor (Vw1)...")
    s_path = os.path.join(SYNC_CAT, "Vw (Driver E)", "Vw01", "S-Vw1.csv")
    df_s = clean_cols(pd.read_csv(s_path, encoding='latin1'))
    
    n = len(df_s)
    t_min = np.arange(n) * 0.1 / 60.0 # minutes
    
    fig, axes = plt.subplots(3, 1, figsize=(14, 9), sharex=True)
    
    # Accelerometer X, Y, Z
    ax = get_col(df_s, 'ACCELEROMETER', 'X')
    ay = get_col(df_s, 'ACCELEROMETER', 'Y')
    az = get_col(df_s, 'ACCELEROMETER', 'Z')
    axes[0].plot(t_min, ax, label=f'Accel X (mean: {np.mean(ax):.3f}, std: {np.std(ax):.3f})', color='#1f77b4', alpha=0.7)
    axes[0].plot(t_min, ay, label=f'Accel Y (mean: {np.mean(ay):.3f}, std: {np.std(ay):.3f})', color='#2ca02c', alpha=0.7)
    axes[0].plot(t_min, az, label=f'Accel Z (mean: {np.mean(az):.3f}, std: {np.std(az):.3f})', color='#d62728', alpha=0.7)
    axes[0].set_ylabel(r'Accel ($m/s^2$)')
    axes[0].set_title(r'Stationary Run Vw1 (34 min): Accelerometer Noise Floor and Gravity Vector ($Z \approx 9.81 m/s^2$)')
    axes[0].legend(loc='right')
    axes[0].grid(True, alpha=0.3)
    
    # Gyroscope Yaw, Pitch, Roll (rad/s)
    gy = get_col(df_s, 'GYROSCOPE', 'YAW')
    gp = get_col(df_s, 'GYROSCOPE', 'PITCH')
    gr = get_col(df_s, 'GYROSCOPE', 'ROLL')
    axes[1].plot(t_min, gy, label=f'Gyro Yaw (mean: {np.mean(gy):.5f}, std: {np.std(gy):.5f} rad/s)', color='#9467bd', alpha=0.7)
    axes[1].plot(t_min, gp, label=f'Gyro Pitch (mean: {np.mean(gp):.5f}, std: {np.std(gp):.5f} rad/s)', color='#8c564b', alpha=0.7)
    axes[1].plot(t_min, gr, label=f'Gyro Roll (mean: {np.mean(gr):.5f}, std: {np.std(gr):.5f} rad/s)', color='#e377c2', alpha=0.7)
    axes[1].set_ylabel('Gyro (rad/s)')
    axes[1].set_title('Stationary Run Vw1: Gyroscope Static Bias and Thermal Drift')
    axes[1].legend(loc='right')
    axes[1].grid(True, alpha=0.3)
    
    # Magnetometer X, Y, Z (microTesla)
    mx = get_col(df_s, 'MAGNETIC FIELD', 'X')
    my = get_col(df_s, 'MAGNETIC FIELD', 'Y')
    mz = get_col(df_s, 'MAGNETIC FIELD', 'Z')
    axes[2].plot(t_min, mx, label=rf'Mag X (mean: {np.mean(mx):.1f} $\mu T$)', color='#7f7f7f', alpha=0.7)
    axes[2].plot(t_min, my, label=rf'Mag Y (mean: {np.mean(my):.1f} $\mu T$)', color='#bcbd22', alpha=0.7)
    axes[2].plot(t_min, mz, label=rf'Mag Z (mean: {np.mean(mz):.1f} $\mu T$)', color='#17becf', alpha=0.7)
    axes[2].set_ylabel(r'Magnetic Field ($\mu T$)')
    axes[2].set_xlabel('Elapsed Time (minutes)')
    axes[2].set_title('Stationary Run Vw1: Magnetometer Environmental Stability')
    axes[2].legend(loc='right')
    axes[2].grid(True, alpha=0.3)
    
    plt.tight_layout()
    out_path = os.path.join(PLOTS_DIR, "fig3_stationary_noise_floor_vw1.png")
    plt.savefig(out_path, dpi=200)
    plt.close()
    print(f"Saved: {out_path}")

def generate_fig4_scenarios():
    print("Generating Fig 4: Difficult Motion Scenarios...")
    s_path = os.path.join(SYNC_CAT, "Vw (Driver E)", "Vw04", "S-Vw4.csv")
    v_path = os.path.join(SYNC_CAT, "Vw (Driver E)", "Vw04", "V-Vw4.csv")
    
    start = 15000
    n = 2000
    df_s = clean_cols(pd.read_csv(s_path, encoding='latin1', skiprows=range(1, start), nrows=n))
    df_v = clean_cols(pd.read_csv(v_path, encoding='latin1', skiprows=range(1, start), nrows=n))
    
    t = np.arange(n) * 0.1
    v_spd = get_col(df_v, 'VELOCITY')
    v_yaw = get_col(df_v, 'YAW RATE')
    v_acc = get_col(df_v, 'LONGITUDINAL ACCELERATION') * 9.80665
    s_ax = get_col(df_s, 'ACCELEROMETER', 'X') - get_col(df_s, 'GRAVITY', 'X')
    s_gp = get_col(df_s, 'GYROSCOPE', 'PITCH') * 180.0 / np.pi
    
    fig, axes = plt.subplots(3, 1, figsize=(14, 8), sharex=True)
    
    axes[0].plot(t, v_spd, color='black', label='Vehicle Speed (km/h)')
    axes[0].set_ylabel('Speed (km/h)')
    axes[0].set_title('Scenario Dynamics: Urban & Suburban Maneuvers (Run Vw04)')
    axes[0].legend(loc='upper right')
    axes[0].grid(True, alpha=0.3)
    
    axes[1].plot(t, v_yaw, color='#2ca02c', label='VBOX Yaw Rate (deg/s)', linewidth=1.5)
    axes[1].plot(t, s_gp, color='#1f77b4', label='Phone Gyro Pitch (deg/s)', alpha=0.7)
    axes[1].set_ylabel('Yaw Rate (deg/s)')
    axes[1].set_title('Turning & Roundabouts: High Angular Excursions')
    axes[1].legend(loc='upper right')
    axes[1].grid(True, alpha=0.3)
    
    axes[2].plot(t, v_acc, color='#2ca02c', label='VBOX Long Accel ($m/s^2$)', linewidth=1.5)
    axes[2].plot(t, s_ax, color='#ff7f0e', label='Phone Linear Accel X ($m/s^2$)', alpha=0.6, linewidth=0.8)
    axes[2].set_ylabel(r'Accel ($m/s^2$)')
    axes[2].set_xlabel('Elapsed Time in Window (s)')
    axes[2].set_title('Braking and Road Vibration: True Dynamics vs High-Frequency Noise')
    axes[2].legend(loc='upper right')
    axes[2].grid(True, alpha=0.3)
    
    plt.tight_layout()
    out_path = os.path.join(PLOTS_DIR, "fig4_difficult_scenarios.png")
    plt.savefig(out_path, dpi=200)
    plt.close()
    print(f"Saved: {out_path}")

def generate_fig5_offsets():
    print("Generating Fig 5: Cross-Correlation Lag Demonstration...")
    runs = [
        ("S1 (Driver A)", r"S (Driver A)\S1\S-S1.csv", r"S (Driver A)\S1\V-S1.csv", '#1f77b4'),
        ("Vta01a (Driver E)", r"Vta (Driver E)\Vta01a\S-Vta1a.csv", r"Vta (Driver E)\Vta01a\V-Vta1a.csv", '#d62728'),
        ("Vtb05 (Driver E)", r"Vtb (Driver E)\Vtb05\S-Vtb5.csv", r"Vtb (Driver E)\Vtb05\V-vtb5.csv", '#2ca02c'),
        ("Vw02 (Driver E)", r"Vw (Driver E)\Vw02\S-Vw2.csv", r"Vw (Driver E)\Vw02\V-Vw2.csv", '#9467bd'),
    ]
    
    plt.figure(figsize=(12, 6))
    lags_s = np.linspace(-30, 30, 601)
    lags_steps = (lags_s * 10).astype(int)
    
    for name, s_rel, v_rel, color in runs:
        sp = os.path.join(SYNC_CAT, s_rel)
        vp = os.path.join(SYNC_CAT, v_rel)
        df_s = clean_cols(pd.read_csv(sp, encoding='latin1', nrows=15000))
        df_v = clean_cols(pd.read_csv(vp, encoding='latin1', nrows=15000))
        n = min(len(df_s), len(df_v))
        s_spd = get_col(df_s, 'GPS SPEED')[:n].astype(float)
        v_spd = get_col(df_v, 'VELOCITY')[:n].astype(float)
        
        corrs = []
        for step in lags_steps:
            if step < 0:
                xs = s_spd[:step]
                ys = v_spd[-step:]
            elif step > 0:
                xs = s_spd[step:]
                ys = v_spd[:-step]
            else:
                xs = s_spd
                ys = v_spd
            c = np.corrcoef(xs, ys)[0, 1] if len(xs) > 100 and np.std(xs) > 0.1 else 0.0
            corrs.append(c)
            
        best_idx = np.argmax(corrs)
        best_lag_s = lags_s[best_idx]
        best_corr = corrs[best_idx]
        plt.plot(lags_s, corrs, label=f'{name} (Peak at {best_lag_s:+.1f}s, r={best_corr:.3f})', color=color, linewidth=1.8)
        plt.scatter([best_lag_s], [best_corr], color=color, s=50, zorder=5)

    plt.axvline(0, color='black', linestyle='--', alpha=0.5, label='Nominal Synchronized Point (Lag = 0)')
    plt.xlabel('Time Offset Lag applied to S relative to V (seconds)')
    plt.ylabel('Pearson Cross-Correlation')
    plt.title('Evidence of Inter-Session Clock Offsets in "Synchronised V and S" Dataset')
    plt.legend(loc='lower left')
    plt.grid(True, alpha=0.3)
    plt.tight_layout()
    out_path = os.path.join(PLOTS_DIR, "fig5_sync_offset_demonstration.png")
    plt.savefig(out_path, dpi=200)
    plt.close()
    print(f"Saved: {out_path}")

if __name__ == "__main__":
    generate_fig1_sampling()
    generate_fig2_sync_s1()
    generate_fig3_stationary_vw1()
    generate_fig4_scenarios()
    generate_fig5_offsets()
    print("All 5 audit plots generated successfully!")

