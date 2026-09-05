"""ENU/WGS84 helpers and scalar-first quaternion rotations (body -> ENU)."""
from __future__ import annotations
import numpy as np

EARTH_RADIUS_M = 6378137.0

def skew(v: np.ndarray) -> np.ndarray:
    x, y, z = np.asarray(v, dtype=float)
    return np.array([[0., -z, y], [z, 0., -x], [-y, x, 0.]])

def quat_normalize(q: np.ndarray) -> np.ndarray:
    q = np.asarray(q, dtype=float)
    n = np.linalg.norm(q)
    if n == 0: raise ValueError("zero quaternion")
    return q / n

def quat_multiply(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    aw, ax, ay, az = a; bw, bx, by, bz = b
    return np.array([aw*bw-ax*bx-ay*by-az*bz, aw*bx+ax*bw+ay*bz-az*by,
                     aw*by-ax*bz+ay*bw+az*bx, aw*bz+ax*by-ay*bx+az*bw])

def quat_from_rotvec(r: np.ndarray) -> np.ndarray:
    angle = float(np.linalg.norm(r))
    if angle < 1e-10: return quat_normalize(np.r_[1.0, 0.5*np.asarray(r)])
    return np.r_[np.cos(angle/2), np.sin(angle/2)*np.asarray(r)/angle]

def quat_to_matrix(q: np.ndarray) -> np.ndarray:
    w, x, y, z = quat_normalize(q)
    return np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                     [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                     [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])

def enu_to_wgs84(enu: np.ndarray, origin_lat_deg: float, origin_lon_deg: float) -> tuple[float, float]:
    east, north = np.asarray(enu)[:2]
    lat = origin_lat_deg + np.degrees(north / EARTH_RADIUS_M)
    lon = origin_lon_deg + np.degrees(east / (EARTH_RADIUS_M*np.cos(np.radians(origin_lat_deg))))
    return float(lat), float(lon)

def wgs84_to_enu(lat_deg: float, lon_deg: float, origin_lat_deg: float, origin_lon_deg: float) -> np.ndarray:
    north = EARTH_RADIUS_M*np.radians(lat_deg-origin_lat_deg)
    east = EARTH_RADIUS_M*np.cos(np.radians(origin_lat_deg))*np.radians(lon_deg-origin_lon_deg)
    return np.array([east, north, 0.])
