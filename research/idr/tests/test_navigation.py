import unittest
import numpy as np
from research.idr.navigation.coordinates import quat_from_rotvec, quat_to_matrix, enu_to_wgs84, wgs84_to_enu
from research.idr.navigation.eskf import ErrorStateKalmanFilter, NavigationState
from research.idr.navigation.motion_adapter import MotionInputWindow, MotionPrediction
from research.idr.navigation.constraints import soft_polyline_measurement
from research.idr.navigation.outage import run_outage, OutageConfig

class ConstantPredictor:
    def predict(self, window):
        return MotionPrediction(window.timestamp_end_s,10.,0.,.1,.02,1.)

class NavigationTests(unittest.TestCase):
    def test_quaternion_rotation(self):
        q=quat_from_rotvec(np.array([0.,0.,np.pi/2])); np.testing.assert_allclose(quat_to_matrix(q)@np.array([1.,0.,0.]),[0,1,0],atol=1e-7)
    def test_wgs84_enu_round_trip(self):
        p=wgs84_to_enu(52.4001,-1.5001,52.4,-1.5); lat,lon=enu_to_wgs84(p,52.4,-1.5); self.assertAlmostEqual(lat,52.4001,places=7); self.assertAlmostEqual(lon,-1.5001,places=7)
    def test_initialization_and_covariance(self):
        f=ErrorStateKalmanFilter(); self.assertEqual(f.P.shape,(15,15)); self.assertTrue(np.all(np.linalg.eigvalsh(f.P)>0))
    def test_stationary_propagation(self):
        f=ErrorStateKalmanFilter();
        for _ in range(100): f.propagate(np.array([0,0,9.80665]),np.zeros(3),.1)
        np.testing.assert_allclose(f.state.position_enu_m,np.zeros(3),atol=1e-6)
    def test_covariance_propagates(self):
        f=ErrorStateKalmanFilter(); before=float(np.trace(f.P)); f.propagate(np.array([0,0,9.80665]),np.zeros(3),.1); self.assertGreater(float(np.trace(f.P)),before)
    def test_gnss_update_reduces_error(self):
        f=ErrorStateKalmanFilter(); f.state.position_enu_m[:2]=[100.,-50.]; before=np.linalg.norm(f.state.position_enu_m); f.update_gnss(np.zeros(3),1.); self.assertLess(np.linalg.norm(f.state.position_enu_m),before)
    def test_nhc_drives_lateral_vertical_velocity_down(self):
        f=ErrorStateKalmanFilter(NavigationState(velocity_enu_mps=np.array([8.,3.,2.]))); before=np.linalg.norm(f.state.velocity_enu_mps[1:])
        for _ in range(4): f.update_nhc(.1,.1)
        self.assertLess(np.linalg.norm(f.state.velocity_enu_mps[1:]),before)
    def test_soft_constraint_does_not_hard_snap(self):
        m=soft_polyline_measurement(np.array([2.,10.,0.]),np.array([1.,0.,0.]),np.array([[0.,0.],[100.,0.]])); self.assertIsNotNone(m); self.assertGreater(m[1][0,0],0)
    def test_constraint_releases_when_far_from_road(self):
        self.assertIsNone(soft_polyline_measurement(np.array([0.,100.,0.]),np.array([1.,0.,0.]),np.array([[0.,0.],[100.,0.]])))
    def test_motion_update_uses_velocity_measurement(self):
        f=ErrorStateKalmanFilter(NavigationState(velocity_enu_mps=np.array([1.,0.,0.]))); p=MotionPrediction(0.,10.,0.,.1,.1,1.); f.update_motion(p,0.); self.assertGreater(f.state.velocity_enu_mps[0],1.)
    def test_adapter_window_rejects_future_interval(self):
        with self.assertRaises(ValueError): MotionInputWindow(np.zeros((20,6)),'vehicle',2.,1.)
    def test_outage_is_reference_independent(self):
        t=np.arange(0.,8.,.1); imu=np.zeros((len(t),6)); imu[:,2]=9.80665
        # Different withheld future GNSS/reference arrays must not influence the outage output.
        a=run_outage(t,imu,ConstantPredictor(),ErrorStateKalmanFilter(),OutageConfig(2.,4.),np.zeros((len(t),3)))
        altered=np.zeros((len(t),3)); altered[t>=6]=999.  # only reference after outage recovery is altered
        b=run_outage(t,imu,ConstantPredictor(),ErrorStateKalmanFilter(),OutageConfig(2.,4.),altered)
        mask=(t>=2)&(t<6); np.testing.assert_allclose(a[mask],b[mask],atol=1e-10)

if __name__ == '__main__': unittest.main()
