"""Soft road/route measurements; neither function performs a hard snap."""
from __future__ import annotations
import numpy as np

def closest_point_on_polyline(point: np.ndarray, polyline: np.ndarray):
    p=np.asarray(point)[:2]; line=np.asarray(polyline)[:,:2]; best=None
    for a,b in zip(line[:-1],line[1:]):
        d=b-a; t=np.clip(np.dot(p-a,d)/max(np.dot(d,d),1e-12),0,1); q=a+t*d; cand=(np.linalg.norm(p-q),q,d/max(np.linalg.norm(d),1e-12))
        if best is None or cand[0]<best[0]: best=cand
    return best

def soft_polyline_measurement(position_enu: np.ndarray, heading_enu: np.ndarray, polyline_enu: np.ndarray, sigma_m=8., max_distance_m=35., min_alignment=.0):
    """Return (target,covariance) only if close and heading-compatible."""
    dist,target,tangent=closest_point_on_polyline(position_enu,polyline_enu)
    align=float(np.dot(heading_enu[:2],tangent)/max(np.linalg.norm(heading_enu[:2]),1e-9))
    if dist>max_distance_m or align<min_alignment: return None
    # Grow uncertainty with residual: strong preference close to road, naturally releases far away.
    return target, np.eye(2)*(sigma_m**2+(dist*.5)**2)
