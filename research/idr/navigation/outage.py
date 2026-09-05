"""Sequential GNSS outage runner. Reference arrays are accepted only after filtering, for metrics."""
from __future__ import annotations
from dataclasses import dataclass
import numpy as np
from .eskf import ErrorStateKalmanFilter
from .motion_adapter import MotionInputWindow, MotionPredictor
from .coordinates import quat_to_matrix, quat_from_rotvec
from .constraints import soft_polyline_measurement

@dataclass
class OutageConfig:
    start_s: float; duration_s: float; use_nhc: bool=True; route_enu: np.ndarray|None=None; road_enu: np.ndarray|None=None
    # These values must be calculated solely from S GNSS samples at or before
    # start_s. They provide a physical state at the moment GNSS is lost.
    initial_position_enu: np.ndarray|None=None
    initial_velocity_enu_mps: np.ndarray|None=None
    initial_heading_enu_rad: float|None=None

def run_outage(times_s, vehicle_imu, predictor: MotionPredictor, eskf: ErrorStateKalmanFilter, config: OutageConfig, gnss_enu=None, gnss_std_m=5.):
    """Processes chronological S-derived vehicle IMU. GNSS is ignored inside [start,end)."""
    ts=np.asarray(times_s); imu=np.asarray(vehicle_imu); positions=[]; last=ts[0]; start=config.start_s; end=start+config.duration_s; win=[]; outage_initialized=False
    for k,t in enumerate(ts):
        dt=float(t-last); last=t; x=imu[k]; eskf.propagate(x[:3],np.array([x[5],x[4],x[3]]),dt); win.append(x)
        if len(win)>20: win.pop(0)
        outage=start<=t<end
        # Explicit state hand-off when GNSS becomes unavailable. This is not a
        # reference update: all three inputs were computed from S GNSS history.
        if outage and not outage_initialized:
            if config.initial_position_enu is not None: eskf.state.position_enu_m=np.asarray(config.initial_position_enu,dtype=float).copy()
            if config.initial_velocity_enu_mps is not None: eskf.state.velocity_enu_mps=np.asarray(config.initial_velocity_enu_mps,dtype=float).copy()
            if config.initial_heading_enu_rad is not None: eskf.state.q_nb=quat_from_rotvec(np.array([0.,0.,config.initial_heading_enu_rad]))
            outage_initialized=True
        if not outage and gnss_enu is not None: eskf.update_gnss(gnss_enu[k],gnss_std_m)
        if len(win)==20:
            pred=predictor.predict(MotionInputWindow(np.asarray(win),'vehicle_body',float(ts[k-19]),float(t))); eskf.update_motion(pred, float(x[3]))
        # NHC is not meaningful while stationary and must never be made an
        # infinitely strong constraint.
        if config.use_nhc and np.linalg.norm(eskf.state.velocity_enu_mps[:2]) > 1.5: eskf.update_nhc()
        if outage:
            R=quat_to_matrix(eskf.state.q_nb); heading=R[:,0]
            for polyline in (config.road_enu,config.route_enu):
                if polyline is not None:
                    m=soft_polyline_measurement(eskf.state.position_enu_m,heading,polyline)
                    if m: eskf.update_soft_position(*m)
        positions.append(eskf.state.position_enu_m.copy())
    return np.asarray(positions)
