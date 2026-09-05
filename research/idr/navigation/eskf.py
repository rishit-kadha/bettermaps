"""15-state ESKF: nominal [p_ENU,v_ENU,q_NB,b_a,b_g], error [dp,dv,dtheta,dba,dbg]."""
from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np
from .coordinates import quat_from_rotvec, quat_multiply, quat_normalize, quat_to_matrix, skew
from .motion_adapter import MotionPrediction

@dataclass
class NavigationState:
    position_enu_m: np.ndarray = field(default_factory=lambda: np.zeros(3))
    velocity_enu_mps: np.ndarray = field(default_factory=lambda: np.zeros(3))
    q_nb: np.ndarray = field(default_factory=lambda: np.array([1.,0.,0.,0.])) # body -> ENU
    accel_bias_mps2: np.ndarray = field(default_factory=lambda: np.zeros(3))
    gyro_bias_radps: np.ndarray = field(default_factory=lambda: np.zeros(3))

class ErrorStateKalmanFilter:
    """Numerically stabilized quaternion ESKF. ENU has gravity [0,0,-9.80665]."""
    def __init__(self, state: NavigationState | None = None, covariance: np.ndarray | None = None):
        self.state = state or NavigationState()
        self.P = np.eye(15) if covariance is None else np.asarray(covariance, dtype=float)
        self.gravity = np.array([0.,0.,-9.80665])
        self.accel_noise, self.gyro_noise = .35, .03
        self.accel_bias_rw, self.gyro_bias_rw = .01, .002
    def propagate(self, accel_body_mps2: np.ndarray, gyro_body_radps: np.ndarray, dt_s: float) -> None:
        if not 0 < dt_s <= 1.0: return
        s=self.state; R=quat_to_matrix(s.q_nb); a_b=np.asarray(accel_body_mps2)-s.accel_bias_mps2; w=np.asarray(gyro_body_radps)-s.gyro_bias_radps
        a_n=R@a_b+self.gravity; s.position_enu_m += s.velocity_enu_mps*dt_s+.5*a_n*dt_s*dt_s; s.velocity_enu_mps += a_n*dt_s
        s.q_nb=quat_normalize(quat_multiply(s.q_nb, quat_from_rotvec(w*dt_s)))
        F=np.zeros((15,15)); F[0:3,3:6]=np.eye(3); F[3:6,6:9]=-R@skew(a_b); F[3:6,9:12]=-R; F[6:9,6:9]=-skew(w); F[6:9,12:15]=-np.eye(3)
        G=np.zeros((15,12)); G[3:6,0:3]=R; G[6:9,3:6]=np.eye(3); G[9:12,6:9]=np.eye(3); G[12:15,9:12]=np.eye(3)
        Qc=np.diag([self.accel_noise**2]*3+[self.gyro_noise**2]*3+[self.accel_bias_rw**2]*3+[self.gyro_bias_rw**2]*3)
        Phi=np.eye(15)+F*dt_s; self.P=Phi@self.P@Phi.T+G@Qc@G.T*dt_s; self._stabilize()
    def update(self, residual: np.ndarray, H: np.ndarray, Rm: np.ndarray) -> None:
        S=H@self.P@H.T+Rm; K=np.linalg.solve(S, H@self.P).T; dx=K@residual; self._inject(dx); I=np.eye(15); self.P=(I-K@H)@self.P@(I-K@H).T+K@Rm@K.T; self._stabilize()
    def update_gnss(self, position_enu_m: np.ndarray, std_m: float, velocity_enu_mps: np.ndarray | None=None, velocity_std_mps: float=1.0) -> None:
        z=np.asarray(position_enu_m); H=np.zeros((3,15)); H[:,:3]=np.eye(3); self.update(z-self.state.position_enu_m,H,np.eye(3)*std_m**2)
        if velocity_enu_mps is not None:
            H=np.zeros((3,15)); H[:,3:6]=np.eye(3); self.update(np.asarray(velocity_enu_mps)-self.state.velocity_enu_mps,H,np.eye(3)*velocity_std_mps**2)
    def update_motion(self, prediction: MotionPrediction, measured_yaw_rate_radps: float | None = None) -> None:
        Rnb=quat_to_matrix(self.state.q_nb); Rbn=Rnb.T; v_b=Rbn@self.state.velocity_enu_mps
        H=np.zeros((1,15)); H[0,3:6]=Rbn[0]; H[0,6:9]=(-skew(v_b))[0]
        self.update(np.array([prediction.forward_velocity_mps-v_b[0]]),H,np.array([[prediction.velocity_std_mps**2]]))
        # The learned yaw-rate measurement calibrates gyro-z bias only when the raw gyro
        # observation is supplied. h = omega_measured_z - b_gz.
        if measured_yaw_rate_radps is not None:
            H=np.zeros((1,15)); H[0,14]=-1.
            residual = prediction.yaw_rate_radps - (measured_yaw_rate_radps-self.state.gyro_bias_radps[2])
            self.update(np.array([residual]),H,np.array([[prediction.yaw_rate_std_radps**2]]))
    def update_nhc(self, lateral_std_mps=.35, vertical_std_mps=.20) -> None:
        Rbn=quat_to_matrix(self.state.q_nb).T; vb=Rbn@self.state.velocity_enu_mps; H=np.zeros((2,15)); H[:,3:6]=Rbn[1:3]; H[:,6:9]=(-skew(vb))[1:3]
        self.update(-vb[1:3],H,np.diag([lateral_std_mps**2,vertical_std_mps**2]))
    def update_soft_position(self, target_enu_m: np.ndarray, covariance_m2: np.ndarray) -> None:
        H=np.zeros((2,15)); H[:,0:2]=np.eye(2); self.update(np.asarray(target_enu_m)[:2]-self.state.position_enu_m[:2],H,np.asarray(covariance_m2))
    def _inject(self, dx):
        s=self.state; s.position_enu_m+=dx[0:3]; s.velocity_enu_mps+=dx[3:6]; s.q_nb=quat_normalize(quat_multiply(s.q_nb,quat_from_rotvec(dx[6:9]))); s.accel_bias_mps2+=dx[9:12]; s.gyro_bias_radps+=dx[12:15]
    def _stabilize(self):
        self.P=(self.P+self.P.T)*.5; vals,vecs=np.linalg.eigh(self.P); self.P=vecs@np.diag(np.maximum(vals,1e-12))@vecs.T
