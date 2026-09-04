"""
Model Training Engine for BetterMaps IDR.

Implements:
- Training loop with AdamW optimizer, ReduceLROnPlateau scheduler.
- Checkpoint saving on best validation loss.
- Early stopping (patience=4 epochs).
- Metric evaluation per epoch.
"""

import os
import time
import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from typing import Dict, Any, Optional, Tuple, List
import numpy as np

from research.idr.preprocessing.transforms import IdrWindowDataset, FeatureNormalizer
from research.idr.training.loss import WeightedMotionLoss
from research.idr.evaluation.metrics import compute_metrics


def train_model(
    model: nn.Module,
    train_dataset: IdrWindowDataset,
    val_dataset: IdrWindowDataset,
    run_dir: str,
    lambda_omega: float = 1.0,
    lr: float = 1e-3,
    batch_size: int = 256,
    max_epochs: int = 15,
    patience: int = 4,
    device: str = "cpu"
) -> Dict[str, Any]:
    """
    Trains a neural IDR model and checkpoints the best validation state.
    """
    os.makedirs(run_dir, exist_ok=True)
    model.to(device)
    
    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True, drop_last=True)
    val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False)
    
    criterion = WeightedMotionLoss(lambda_omega=lambda_omega)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode='min', factor=0.5, patience=2)
    
    best_val_loss = float('inf')
    best_epoch = 0
    patience_counter = 0
    history: List[Dict[str, float]] = []
    
    start_time = time.time()
    print(f"Starting training: {model.__class__.__name__} | lambda_omega={lambda_omega} | Epochs={max_epochs} | Device={device}")
    
    for epoch in range(1, max_epochs + 1):
        epoch_start = time.time()
        # Train phase
        model.train()
        train_loss_total = 0.0
        train_batches = 0
        
        for X_b, y_b in train_loader:
            X_b = X_b.to(device)
            y_b = y_b.to(device)
            
            optimizer.zero_grad()
            preds = model(X_b)
            loss = criterion(preds, y_b)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
            optimizer.step()
            
            train_loss_total += loss.item()
            train_batches += 1
            
        train_loss = train_loss_total / max(1, train_batches)
        
        # Validation phase
        model.eval()
        val_loss_total = 0.0
        val_batches = 0
        all_preds = []
        all_targets = []
        
        with torch.no_grad():
            for X_v, y_v in val_loader:
                X_v = X_v.to(device)
                y_v = y_v.to(device)
                preds_v = model(X_v)
                loss_v = criterion(preds_v, y_v)
                val_loss_total += loss_v.item()
                val_batches += 1
                
                all_preds.append(preds_v.cpu().numpy())
                all_targets.append(y_v.cpu().numpy())
                
        val_loss = val_loss_total / max(1, val_batches)
        scheduler.step(val_loss)
        
        # Compute epoch metrics on validation
        y_p_arr = np.concatenate(all_preds, axis=0)
        y_t_arr = np.concatenate(all_targets, axis=0)
        epoch_metrics = compute_metrics(y_t_arr, y_p_arr, lambda_omega=lambda_omega)
        
        epoch_time = time.time() - epoch_start
        print(
            f"Epoch {epoch:02d}/{max_epochs:02d} [{epoch_time:.1f}s] - "
            f"Train Loss: {train_loss:.4f} | Val Loss: {val_loss:.4f} | "
            f"v_RMSE: {epoch_metrics['v_rmse_kmh']:.1f} km/h | w_RMSE: {epoch_metrics['w_rmse_degps']:.2f} deg/s | "
            f"Drift: {epoch_metrics['drift_rate_deg_per_min']:.1f} deg/min"
        )
        
        history.append({
            "epoch": epoch,
            "train_loss": round(train_loss, 4),
            "val_loss": round(val_loss, 4),
            **epoch_metrics
        })
        
        # Checkpointing
        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_epoch = epoch
            patience_counter = 0
            best_model_path = os.path.join(run_dir, "best_model.pt")
            torch.save({
                "epoch": epoch,
                "model_state": model.state_dict(),
                "model_class": model.__class__.__name__,
                "lambda_omega": lambda_omega,
                "val_loss": val_loss,
                "metrics": epoch_metrics
            }, best_model_path)
        else:
            patience_counter += 1
            if patience_counter >= patience:
                print(f"Early stopping triggered at epoch {epoch} (best epoch: {best_epoch}).")
                break
                
    total_time = time.time() - start_time
    print(f"Training completed in {total_time:.1f}s. Best Val Loss: {best_val_loss:.4f} at epoch {best_epoch}.")
    
    # Reload best model weights
    best_ckpt = torch.load(os.path.join(run_dir, "best_model.pt"))
    model.load_state_dict(best_ckpt["model_state"])
    
    return {
        "best_epoch": best_epoch,
        "best_val_loss": best_val_loss,
        "best_metrics": best_ckpt["metrics"],
        "history": history,
        "total_training_time_s": round(total_time, 1)
    }

