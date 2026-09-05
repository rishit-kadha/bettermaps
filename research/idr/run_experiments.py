"""
Master Experiment Runner for BetterMaps IDR Phase 5.

Executes:
- Phase 5A: Classical & Neural Baselines (B0.1, B0.2, B0.3, B1, B2, B3)
- Phase 5B: Controlled loss weight sweep (lambda_omega in {0.1, 0.25, 0.5, 1.0, 2.0, 4.0}) on Validation
- Phase 5C: Test-Set Locking & ONE Final Test Evaluation
- Phase 5D: Multi-outage trajectory evaluation (5s, 10s, 20s, 30s, 60s)
- Phase 5E: Heteroscedastic uncertainty head & calibration analysis
- Phase 5F: 50 Hz resampled comparison experiment
- Master registry generation: artifacts/experiment_registry.csv
"""

import os
import sys
import json
import time
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from torch.utils.data import DataLoader
import matplotlib.pyplot as plt

# Ensure project root in sys.path
sys.path.insert(0, os.path.abspath("."))

from research.idr.data.loader import IovnbdLoader
from research.idr.preprocessing.transforms import FeatureNormalizer, IdrWindowDataset
from research.idr.models.baselines import MeanBaseline, PersistenceBaseline, RidgeBaseline
from research.idr.models.mlp import ShallowMlpMotionModel
from research.idr.models.tcn import TinyCausalTcnMotionModel
from research.idr.models.gru import LightweightGruMotionModel
from research.idr.models.uncertainty import HeteroscedasticTcnModel, GaussianNllLoss
from research.idr.training.train import train_model
from research.idr.training.loss import WeightedMotionLoss
from research.idr.evaluation.metrics import compute_metrics
from research.idr.evaluation.dead_reckoning import evaluate_outages_for_session, summarize_outage_benchmark


def main():
    print("=================================================================")
    print("BETTERMAPS IDR - PHASE 5 COMPREHENSIVE TRAINING & EXPERIMENTS")
    print("=================================================================")
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Using compute device: {device}")
    
    # 1. Load Sessions & Preprocessing
    loader = IovnbdLoader()
    with open("artifacts/data/train_sessions.txt") as f:
        train_ids = [l.strip() for l in f if l.strip()]
    with open("artifacts/data/val_sessions.txt") as f:
        val_ids = [l.strip() for l in f if l.strip()]
    with open("artifacts/data/test_sessions.txt") as f:
        test_ids = [l.strip() for l in f if l.strip()]
        
    print(f"Loading datasets: {len(train_ids)} Train, {len(val_ids)} Val, {len(test_ids)} Test...")
    train_data = [loader.load_session(s) for s in train_ids]
    val_data = [loader.load_session(s) for s in val_ids]
    test_data = [loader.load_session(s) for s in test_ids]
    
    # Normalizer
    normalizer = FeatureNormalizer.load("artifacts/data/normalization.json")
    
    # PyTorch Datasets
    print("Building PyTorch window datasets (stride=4 for train, stride=2 for val/test)...")
    train_ds = IdrWindowDataset(train_data, normalizer, window_size=20, stride=4)
    val_ds = IdrWindowDataset(val_data, normalizer, window_size=20, stride=2)
    test_ds = IdrWindowDataset(test_data, normalizer, window_size=20, stride=2)
    print(f"Dataset window counts -> Train: {len(train_ds):,}, Val: {len(val_ds):,}, Test: {len(test_ds):,}")
    
    # Global training targets for B0.1 Mean Baseline
    all_y_train = np.concatenate([s["y"] for s in train_data], axis=0)
    
    # Extract validation arrays for classical baseline evaluation
    print("Extracting validation arrays for evaluation...")
    val_loader = DataLoader(val_ds, batch_size=1024, shuffle=False)
    X_val_list, y_val_list = [], []
    for X_b, y_b in val_loader:
        X_val_list.append(X_b.numpy())
        y_val_list.append(y_b.numpy())
    X_val_arr = np.concatenate(X_val_list, axis=0) # [N, 20, 6]
    y_val_arr = np.concatenate(y_val_list, axis=0) # [N, 2]
    
    # Stratified Train subset for B0.3 Ridge baseline (shuffled batches across all drivers)
    torch.manual_seed(42)
    train_sample_loader = DataLoader(train_ds, batch_size=512, shuffle=True)
    X_tr_list, y_tr_list = [], []
    for i, (X_b, y_b) in enumerate(train_sample_loader):
        if i >= 60: # 30,720 samples across all drivers for robust Ridge fitting
            break
        X_tr_list.append(X_b.numpy())
        y_tr_list.append(y_b.numpy())
    X_tr_arr = np.concatenate(X_tr_list, axis=0)
    y_tr_arr = np.concatenate(y_tr_list, axis=0)
    
    registry_records = []
    
    # ---------------------------------------------------------------
    # PHASE 5A: Classical & Neural Baselines (lambda_omega = 1.0)
    # ---------------------------------------------------------------
    print("\n>>> PHASE 5A: EVALUATING BASELINES ON VALIDATION SET")
    
    # B0.1: Global Mean Predictor
    print("\n--- B0.1: Global Mean Baseline ---")
    b01 = MeanBaseline().fit(all_y_train)
    p01 = b01.predict(X_val_arr)
    m01 = compute_metrics(y_val_arr, p01, lambda_omega=1.0)
    print("B0.1 Val Metrics:", m01)
    registry_records.append({
        "experiment_id": "B0.1_Mean",
        "model_family": "Classical",
        "model_name": "Global Mean",
        "split_evaluated": "Validation",
        "window_size": 20,
        "lambda_omega": 1.0,
        "param_count": 2,
        **m01
    })
    
    # B0.2: Persistence / Zero-Order Hold
    print("\n--- B0.2: Persistence Baseline ---")
    b02 = PersistenceBaseline(dt=0.100).fit(all_y_train)
    p02 = b02.predict(X_val_arr)
    m02 = compute_metrics(y_val_arr, p02, lambda_omega=1.0)
    print("B0.2 Val Metrics:", m02)
    registry_records.append({
        "experiment_id": "B0.2_Persistence",
        "model_family": "Classical",
        "model_name": "Persistence",
        "split_evaluated": "Validation",
        "window_size": 20,
        "lambda_omega": 1.0,
        "param_count": 0,
        **m02
    })
    
    # B0.3: Ridge Regression
    print("\n--- B0.3: Ridge Regression Baseline ---")
    b03 = RidgeBaseline(alpha=1.0).fit(X_tr_arr, y_tr_arr)
    p03 = b03.predict(X_val_arr)
    m03 = compute_metrics(y_val_arr, p03, lambda_omega=1.0)
    print("B0.3 Val Metrics:", m03)
    registry_records.append({
        "experiment_id": "B0.3_Ridge",
        "model_family": "Classical",
        "model_name": "Ridge Regression",
        "split_evaluated": "Validation",
        "window_size": 20,
        "lambda_omega": 1.0,
        "param_count": 62,
        **m03
    })
    
    # B1: Shallow MLP
    print("\n--- B1: Shallow MLP ---")
    m1 = ShallowMlpMotionModel(window_size=20, in_channels=6, dropout=0.1)
    p_count1 = sum(p.numel() for p in m1.parameters())
    res1 = train_model(
        m1, train_ds, val_ds, 
        run_dir="artifacts/runs/B1_MLP", 
        lambda_omega=1.0, 
        max_epochs=100, 
        device=device
    )
    registry_records.append({
        "experiment_id": "B1_MLP",
        "model_family": "Neural_MLP",
        "model_name": "Shallow MLP",
        "split_evaluated": "Validation",
        "window_size": 20,
        "lambda_omega": 1.0,
        "param_count": p_count1,
        **res1["best_metrics"]
    })
    
    # B2: Tiny 1D Dilated Causal TCN
    print("\n--- B2: Tiny Dilated Causal TCN ---")
    m2 = TinyCausalTcnMotionModel(in_channels=6, hidden_channels=16, kernel_size=3, dilations=[1, 2, 4, 8])
    p_count2 = sum(p.numel() for p in m2.parameters())
    res2 = train_model(
        m2, train_ds, val_ds, 
        run_dir="artifacts/runs/B2_TCN", 
        lambda_omega=1.0, 
        max_epochs=100, 
        device=device
    )
    registry_records.append({
        "experiment_id": "B2_TCN",
        "model_family": "Neural_TCN",
        "model_name": "Tiny Causal TCN",
        "split_evaluated": "Validation",
        "window_size": 20,
        "lambda_omega": 1.0,
        "param_count": p_count2,
        **res2["best_metrics"]
    })
    
    # B3: Lightweight GRU
    print("\n--- B3: Lightweight GRU ---")
    m3 = LightweightGruMotionModel(in_channels=6, hidden_size=32)
    p_count3 = sum(p.numel() for p in m3.parameters())
    res3 = train_model(
        m3, train_ds, val_ds, 
        run_dir="artifacts/runs/B3_GRU", 
        lambda_omega=1.0, 
        max_epochs=100, 
        device=device
    )
    registry_records.append({
        "experiment_id": "B3_GRU",
        "model_family": "Neural_GRU",
        "model_name": "Lightweight GRU",
        "split_evaluated": "Validation",
        "window_size": 20,
        "lambda_omega": 1.0,
        "param_count": p_count3,
        **res3["best_metrics"]
    })
    
    # ---------------------------------------------------------------
    # PHASE 5B: Loss Weight Sweep (lambda_omega in {0.1, 0.25, 0.5, 1.0, 2.0, 4.0})
    # ---------------------------------------------------------------
    print("\n>>> PHASE 5B: CONTROLLED LOSS WEIGHT SWEEP ON VALIDATION SET")
    lambda_values = [0.1, 0.25, 0.5, 1.0, 2.0, 4.0]
    sweep_results = []
    
    # Use TCN as the backbone for the loss sweep
    for lam in lambda_values:
        print(f"\n--- Training TCN with lambda_omega = {lam} ---")
        run_name = f"Sweep_TCN_lam_{str(lam).replace('.', '_')}"
        m_sweep = TinyCausalTcnMotionModel(in_channels=6, hidden_channels=16, kernel_size=3, dilations=[1, 2, 4, 8])
        res_sweep = train_model(
            m_sweep, train_ds, val_ds,
            run_dir=f"artifacts/runs/{run_name}",
            lambda_omega=lam,
            max_epochs=100,
            device=device
        )
        rec = {
            "experiment_id": run_name,
            "model_family": "Neural_TCN_Sweep",
            "model_name": f"TCN (lambda={lam})",
            "split_evaluated": "Validation",
            "window_size": 20,
            "lambda_omega": lam,
            "param_count": p_count2,
            **res_sweep["best_metrics"]
        }
        registry_records.append(rec)
        sweep_results.append(rec)
        
    df_sweep = pd.DataFrame(sweep_results)
    # Select best lambda based on composite validation score and drift rate
    best_sweep_idx = df_sweep["composite_score"].idxmin()
    best_lambda = float(df_sweep.loc[best_sweep_idx, "lambda_omega"])
    print(f"\nOptimal lambda_omega selected on Validation: lambda* = {best_lambda}")
    
    # Plot loss sweep trade-off curve
    fig, ax1 = plt.subplots(figsize=(8, 5))
    ax2 = ax1.twinx()
    lams = df_sweep["lambda_omega"].values
    v_rmses = df_sweep["v_rmse_kmh"].values
    w_rmses = df_sweep["w_rmse_degps"].values
    
    ax1.plot(lams, v_rmses, 'b-o', label='Velocity RMSE (km/h)')
    ax2.plot(lams, w_rmses, 'r-s', label='Yaw Rate RMSE (deg/s)')
    ax1.set_xscale('log')
    ax1.set_xlabel('Loss Weight lambda_omega (log scale)', fontsize=11)
    ax1.set_ylabel('Velocity RMSE (km/h)', color='b', fontsize=11)
    ax2.set_ylabel('Yaw Rate RMSE (deg/s)', color='r', fontsize=11)
    plt.title('Loss Weight lambda_omega Trade-off on Validation Split', fontsize=12, fontweight='bold')
    plt.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig("artifacts/eda/loss_weight_sweep.png", dpi=150)
    plt.close()
    print("Saved loss weight sweep plot to artifacts/eda/loss_weight_sweep.png")
    
    # ---------------------------------------------------------------
    # PHASE 5C: Test-Set Locking & ONE Final Test Evaluation
    # ---------------------------------------------------------------
    print("\n>>> PHASE 5C: FINAL TEST EVALUATION (FROZEN CONFIGURATION)")
    print(f"Locked configuration: Tiny Causal TCN with lambda_omega = {best_lambda}")
    
    # Load test array
    test_loader = DataLoader(test_ds, batch_size=1024, shuffle=False)
    X_test_list, y_test_list = [], []
    for X_b, y_b in test_loader:
        X_test_list.append(X_b.numpy())
        y_test_list.append(y_b.numpy())
    X_test_arr = np.concatenate(X_test_list, axis=0)
    y_test_arr = np.concatenate(y_test_list, axis=0)
    
    # 1. B0.1 on Test
    p01_test = b01.predict(X_test_arr)
    m01_test = compute_metrics(y_test_arr, p01_test, lambda_omega=best_lambda)
    registry_records.append({
        "experiment_id": "TEST_B0.1_Mean",
        "model_family": "Classical",
        "model_name": "Global Mean",
        "split_evaluated": "Test",
        "window_size": 20,
        "lambda_omega": best_lambda,
        "param_count": 2,
        **m01_test
    })
    
    # 2. B0.2 on Test
    p02_test = b02.predict(X_test_arr)
    m02_test = compute_metrics(y_test_arr, p02_test, lambda_omega=best_lambda)
    registry_records.append({
        "experiment_id": "TEST_B0.2_Persistence",
        "model_family": "Classical",
        "model_name": "Persistence",
        "split_evaluated": "Test",
        "window_size": 20,
        "lambda_omega": best_lambda,
        "param_count": 0,
        **m02_test
    })
    
    # 3. B0.3 on Test
    p03_test = b03.predict(X_test_arr)
    m03_test = compute_metrics(y_test_arr, p03_test, lambda_omega=best_lambda)
    registry_records.append({
        "experiment_id": "TEST_B0.3_Ridge",
        "model_family": "Classical",
        "model_name": "Ridge Regression",
        "split_evaluated": "Test",
        "window_size": 20,
        "lambda_omega": best_lambda,
        "param_count": 62,
        **m03_test
    })
    
    # 4. Winning Neural Model (TCN lambda*) on Test
    best_run_dir = f"artifacts/runs/Sweep_TCN_lam_{str(best_lambda).replace('.', '_')}"
    best_ckpt = torch.load(os.path.join(best_run_dir, "best_model.pt"), weights_only=False)
    winning_model = TinyCausalTcnMotionModel(in_channels=6, hidden_channels=16, kernel_size=3, dilations=[1, 2, 4, 8])
    winning_model.load_state_dict(best_ckpt["model_state"])
    winning_model.eval()
    
    # Predict in chunks
    preds_test_list = []
    with torch.no_grad():
        for chunk_idx in range(0, len(X_test_arr), 2048):
            chunk = torch.from_numpy(X_test_arr[chunk_idx : chunk_idx + 2048])
            p_chunk = winning_model(chunk).numpy()
            preds_test_list.append(p_chunk)
    preds_test = np.concatenate(preds_test_list, axis=0)
    
    m_winning_test = compute_metrics(y_test_arr, preds_test, lambda_omega=best_lambda)
    print("\n--- FINAL TEST EVALUATION RESULTS ---")
    print(f"B0.1 Mean Test:        v_RMSE = {m01_test['v_rmse_kmh']} km/h | w_RMSE = {m01_test['w_rmse_degps']} deg/s | Drift = {m01_test['drift_rate_deg_per_min']} deg/min")
    print(f"B0.2 Persistence Test: v_RMSE = {m02_test['v_rmse_kmh']} km/h | w_RMSE = {m02_test['w_rmse_degps']} deg/s | Drift = {m02_test['drift_rate_deg_per_min']} deg/min")
    print(f"B0.3 Ridge Test:       v_RMSE = {m03_test['v_rmse_kmh']} km/h | w_RMSE = {m03_test['w_rmse_degps']} deg/s | Drift = {m03_test['drift_rate_deg_per_min']} deg/min")
    print(f"B2 TCN (Winning) Test: v_RMSE = {m_winning_test['v_rmse_kmh']} km/h | w_RMSE = {m_winning_test['w_rmse_degps']} deg/s | Drift = {m_winning_test['drift_rate_deg_per_min']} deg/min")
    
    registry_records.append({
        "experiment_id": "TEST_WINNING_TCN",
        "model_family": "Neural_TCN_Frozen",
        "model_name": f"Frozen Tiny Causal TCN (lambda={best_lambda})",
        "split_evaluated": "Test",
        "window_size": 20,
        "lambda_omega": best_lambda,
        "param_count": p_count2,
        **m_winning_test
    })
    
    # ---------------------------------------------------------------
    # PHASE 5D: Kinematic Dead-Reckoning Trajectory Outage Benchmark
    # ---------------------------------------------------------------
    print("\n>>> PHASE 5D: KINEMATIC DEAD-RECKONING TRAJECTORY OUTAGE BENCHMARK")
    outage_results_b02 = []
    outage_results_b03 = []
    outage_results_neural = []
    
    for sess in test_data:
        X_s = sess["X"]
        y_ref = sess["y"]
        coords = sess["ref_coords"]
        
        # Normalize
        X_norm = normalizer.transform(X_s)
        N = len(X_s)
        if N < 200:
            continue
            
        windows = []
        for end_idx in range(19, N):
            windows.append(X_norm[end_idx - 19 : end_idx + 1])
        X_win_sess = np.stack(windows, axis=0) # [N - 19, 20, 6]
        
        p_b02_sess = b02.predict(X_win_sess)
        p_b03_sess = b03.predict(X_win_sess)
        
        # Batched neural prediction
        p_neu_list = []
        with torch.no_grad():
            for c_idx in range(0, len(X_win_sess), 2048):
                c_t = torch.from_numpy(X_win_sess[c_idx : c_idx + 2048])
                p_neu_list.append(winning_model(c_t).numpy())
        p_neural_sess = np.concatenate(p_neu_list, axis=0)
            
        # Pad head 19 samples
        p_b02_full = np.pad(p_b02_sess, ((19, 0), (0, 0)), mode='edge')
        p_b03_full = np.pad(p_b03_sess, ((19, 0), (0, 0)), mode='edge')
        p_neural_full = np.pad(p_neural_sess, ((19, 0), (0, 0)), mode='edge')
        
        res_b02 = evaluate_outages_for_session(p_b02_full[:, 0], p_b02_full[:, 1], coords, y_ref)
        res_b03 = evaluate_outages_for_session(p_b03_full[:, 0], p_b03_full[:, 1], coords, y_ref)
        res_neural = evaluate_outages_for_session(p_neural_full[:, 0], p_neural_full[:, 1], coords, y_ref)
        
        outage_results_b02.append(res_b02)
        outage_results_b03.append(res_b03)
        outage_results_neural.append(res_neural)
        
    summary_b02 = summarize_outage_benchmark(outage_results_b02)
    summary_b03 = summarize_outage_benchmark(outage_results_b03)
    summary_neural = summarize_outage_benchmark(outage_results_neural)
    
    print("\n--- TRAJECTORY OUTAGE FINAL POSITION ERROR (ATE) COMPARISON ---")
    outage_table = []
    for dur in [5, 10, 20, 30, 60]:
        d_key = f"{dur}s"
        b02_ate = summary_b02[d_key]["final_ate_mean_m"] if d_key in summary_b02 else 0.0
        b03_ate = summary_b03[d_key]["final_ate_mean_m"] if d_key in summary_b03 else 0.0
        neu_ate = summary_neural[d_key]["final_ate_mean_m"] if d_key in summary_neural else 0.0
        neu_med = summary_neural[d_key]["final_ate_median_m"] if d_key in summary_neural else 0.0
        neu_p90 = summary_neural[d_key]["final_ate_p90_m"] if d_key in summary_neural else 0.0
        cnt = summary_neural[d_key]["sample_count"] if d_key in summary_neural else 0
        
        print(f"Outage {dur:2d}s (N={cnt:3d} intervals): B0.2 Mean ATE = {b02_ate:6.1f}m | B0.3 Mean ATE = {b03_ate:6.1f}m | TCN Mean ATE = {neu_ate:6.1f}m (Median={neu_med:5.1f}m, P90={neu_p90:5.1f}m)")
        outage_table.append({
            "outage_s": dur,
            "interval_count": cnt,
            "b02_mean_ate_m": b02_ate,
            "b03_mean_ate_m": b03_ate,
            "neural_mean_ate_m": neu_ate,
            "neural_median_ate_m": neu_med,
            "neural_p90_ate_m": neu_p90
        })
        
    df_outage = pd.DataFrame(outage_table)
    df_outage.to_csv("artifacts/data/outage_evaluation_summary.csv", index=False)
    
    # Outage error progression plot
    plt.figure(figsize=(9, 5))
    plt.plot(df_outage["outage_s"], df_outage["b02_mean_ate_m"], 'k--o', label="B0.2 Persistence Baseline")
    plt.plot(df_outage["outage_s"], df_outage["b03_mean_ate_m"], 'g--^', label="B0.3 Ridge Baseline")
    plt.plot(df_outage["outage_s"], df_outage["neural_mean_ate_m"], 'b-s', linewidth=2, label="B2 Tiny Causal TCN (Mean)")
    plt.plot(df_outage["outage_s"], df_outage["neural_median_ate_m"], 'b:d', label="B2 Tiny Causal TCN (Median)")
    plt.xlabel("Outage Duration (seconds)", fontsize=11)
    plt.ylabel("Final Position Error ATE (meters)", fontsize=11)
    plt.title("Dead-Reckoning Trajectory Error Across GNSS Outage Durations", fontsize=12, fontweight="bold")
    plt.grid(True, alpha=0.3)
    plt.legend(fontsize=10)
    plt.tight_layout()
    plt.savefig("artifacts/eda/trajectory_outage_curves.png", dpi=150)
    plt.close()
    print("Saved trajectory outage curves to artifacts/eda/trajectory_outage_curves.png")
    
    # ---------------------------------------------------------------
    # PHASE 5E: Heteroscedastic Uncertainty Head
    # ---------------------------------------------------------------
    print("\n>>> PHASE 5E: HETEROSCEDASTIC UNCERTAINTY HEAD & CALIBRATION")
    uncert_model = HeteroscedasticTcnModel(in_channels=6, hidden_channels=16, kernel_size=3, dilations=[1, 2, 4, 8]).to(device)
    uncert_loader = DataLoader(train_ds, batch_size=256, shuffle=True, drop_last=True)
    nll_criterion = GaussianNllLoss(lambda_omega=best_lambda)
    uncert_opt = torch.optim.AdamW(uncert_model.parameters(), lr=1e-3, weight_decay=1e-4)
    
    print("Training Heteroscedastic TCN (4 epochs)...")
    for epoch in range(1, 5):
        uncert_model.train()
        nll_total = 0.0
        n_b = 0
        for X_b, y_b in uncert_loader:
            X_b = X_b.to(device)
            y_b = y_b.to(device)
            uncert_opt.zero_grad()
            mu_b, logvar_b = uncert_model(X_b)
            loss_nll = nll_criterion(mu_b, logvar_b, y_b)
            loss_nll.backward()
            torch.nn.utils.clip_grad_norm_(uncert_model.parameters(), 5.0)
            uncert_opt.step()
            nll_total += loss_nll.item()
            n_b += 1
        print(f"Uncertainty Epoch {epoch}/4 - Mean Gaussian NLL: {nll_total/n_b:.4f}")
        
    # Evaluate calibration on validation set
    uncert_model.eval()
    val_mu_list, val_logvar_list = [], []
    with torch.no_grad():
        for chunk_idx in range(0, len(X_val_arr), 2048):
            c_t = torch.from_numpy(X_val_arr[chunk_idx : chunk_idx + 2048]).to(device)
            m_c, lv_c = uncert_model(c_t)
            val_mu_list.append(m_c.cpu().numpy())
            val_logvar_list.append(lv_c.cpu().numpy())
    mu_val = np.concatenate(val_mu_list, axis=0)
    logvar_val = np.concatenate(val_logvar_list, axis=0)
    sigma_val = np.sqrt(np.exp(logvar_val))
        
    z_scores = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
    expected_coverages = [38.3, 68.3, 86.6, 95.4, 98.8, 99.7]
    actual_coverages_v = []
    actual_coverages_w = []
    
    for z in z_scores:
        cov_v = np.mean(np.abs(y_val_arr[:, 0] - mu_val[:, 0]) <= z * sigma_val[:, 0]) * 100.0
        cov_w = np.mean(np.abs(y_val_arr[:, 1] - mu_val[:, 1]) <= z * sigma_val[:, 1]) * 100.0
        actual_coverages_v.append(cov_v)
        actual_coverages_w.append(cov_w)
        
    print("\nUncertainty Calibration Bins:")
    for z, exp, act_v, act_w in zip(z_scores, expected_coverages, actual_coverages_v, actual_coverages_w):
        print(f"  {z:.1f} sigma: Expected = {exp:5.1f}% | Observed v = {act_v:5.1f}% | Observed omega = {act_w:5.1f}%")
        
    # Calibration Plot
    plt.figure(figsize=(7, 6))
    plt.plot([0, 100], [0, 100], 'k--', label='Perfect Calibration (1:1)')
    plt.plot(expected_coverages, actual_coverages_v, 'b-o', label='Forward Speed (v_f)')
    plt.plot(expected_coverages, actual_coverages_w, 'r-s', label='Yaw Rate (omega_z)')
    plt.xlabel('Expected Coverage (%)', fontsize=11)
    plt.ylabel('Observed Coverage (%)', fontsize=11)
    plt.title('Uncertainty Head Reliability Calibration Curve', fontsize=12, fontweight='bold')
    plt.legend(fontsize=10)
    plt.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig("artifacts/eda/uncertainty_calibration.png", dpi=150)
    plt.close()
    print("Saved calibration plot to artifacts/eda/uncertainty_calibration.png")
    
    # ---------------------------------------------------------------
    # PHASE 5F: 50 Hz Resampled Comparison Experiment
    # ---------------------------------------------------------------
    print("\n>>> PHASE 5F: 50 Hz RESAMPLED COMPARISON EXPERIMENT")
    sample_sess = loader.load_session("S1")
    X_10 = sample_sess["X"]
    y_10 = sample_sess["y"]
    time_10 = sample_sess["time_s"]
    
    from scipy import interpolate
    time_50 = np.arange(time_10[0], time_10[-1], 0.020)
    f_X = interpolate.interp1d(time_10, X_10, axis=0, kind='linear')
    f_y = interpolate.interp1d(time_10, y_10, axis=0, kind='linear')
    X_50 = f_X(time_50)
    y_50 = f_y(time_50)
    
    print(f"S1 at 10 Hz: {len(X_10):,} samples (window=20 samples = 2.0s)")
    print(f"S1 at 50 Hz: {len(X_50):,} samples (window=100 samples = 2.0s)")
    
    # Benchmark CPU inference latency: 10 Hz vs 50 Hz
    dummy_10 = torch.randn(1, 20, 6)
    dummy_50 = torch.randn(1, 100, 6)
    m50 = TinyCausalTcnMotionModel(in_channels=6, hidden_channels=16, kernel_size=3, dilations=[1, 2, 4, 8, 16])
    winning_cpu = winning_model.cpu()
    
    for _ in range(50):
        _ = winning_cpu(dummy_10)
        _ = m50(dummy_50)
        
    t0 = time.perf_counter()
    for _ in range(200):
        _ = winning_cpu(dummy_10)
    lat_10_ms = (time.perf_counter() - t0) / 200.0 * 1000.0
    
    t0 = time.perf_counter()
    for _ in range(200):
        _ = m50(dummy_50)
    lat_50_ms = (time.perf_counter() - t0) / 200.0 * 1000.0
    
    print(f"Single-window inference latency on CPU: 10 Hz = {lat_10_ms:.3f} ms | 50 Hz = {lat_50_ms:.3f} ms")
    compute_ratio = (lat_50_ms * 50.0) / max(1e-4, lat_10_ms * 10.0)
    print(f"Inference compute load per second: 10 Hz = {lat_10_ms * 10:.1f} ms/sec | 50 Hz = {lat_50_ms * 50:.1f} ms/sec ({compute_ratio:.1f}x higher compute!)")
    
    # ---------------------------------------------------------------
    # MASTER EXPERIMENT REGISTRY
    # ---------------------------------------------------------------
    df_reg = pd.DataFrame(registry_records)
    df_reg.to_csv("artifacts/experiment_registry.csv", index=False)
    print("\nSaved master experiment registry to artifacts/experiment_registry.csv")
    print(df_reg[["experiment_id", "split_evaluated", "v_rmse_kmh", "w_rmse_degps", "drift_rate_deg_per_min", "composite_score"]])
    print("\nAll Phase 5 experiments executed successfully!")


if __name__ == "__main__":
    main()

