# Navigation implementation report

## Inspection result

The repository contains an Expo map client and a separate Python research pipeline. The research pipeline has a 6-channel vehicle-frame input (`a_long, a_lat, a_vert, omega_yaw, omega_pitch, omega_roll`), causal windows of 20 samples at nominal 10 Hz, train-only normalization in `artifacts/data/normalization.json`, Tiny causal TCN/GRU/MLP checkpoints, heteroscedastic model definitions, and a direct kinematic outage benchmark. Its existing Python loader estimates S/V alignment and a device-to-vehicle transform. The app has a route geometry provider and bounded post-processing route attraction, but not a Kalman filter.

The former `HybridIdrPositioningEngine` is an ENU direct integrator: it has no nominal quaternion state, error state, covariance propagation, or Kalman measurement update. It remains untouched as the app/baseline implementation.

The supplied M session contains 105,974 matched S and V rows. S has smartphone GPS, accelerometer, gravity, gyroscope, magnetometer and orientation; its `TIME SINCE START` is milliseconds and its initial sample cadence is 100 ms. V has vehicle GPS, velocity, heading, height, yaw rate and vehicle signals; its time is seconds and the stated period is normally 0.1 s (with gaps up to 0.2 s). S units are SI (m/s², rad/s); V speed/yaw are km/h and deg/s. Both contain no blank numeric fields in this session. V is reference/evaluation only in the new outage runner.

## Added

`research/idr/navigation/` adds a real 15-error-state quaternion ESKF, runtime-neutral motion adapter, ENU/WGS84 and quaternion utilities, soft polyline constraints, and a sequential GNSS outage runner. `evaluate_navigation.py` is the model-backed evaluation entry point. `research/idr/tests/test_navigation.py` is a synthetic test suite.

## State and frames

Nominal state: `[p_ENU(3), v_ENU(3), q_NB(w,x,y,z), b_a(3), b_g(3)]`; error state is `[δp, δv, δθ, δb_a, δb_g]` in that order. `q_NB` rotates vehicle body axes (+X forward, +Y left, +Z up) into ENU (+E, +N, +U). Gravity is `[0,0,-9.80665] m/s²`. Covariance is propagated with the continuous error Jacobian and a first-order discrete transition; updates use Joseph covariance form, quaternion error injection, symmetrization, and PSD flooring.

`MotionInputWindow` is causal (`start <= end`) and `MotionPrediction` carries v/yaw plus standard deviations. The legacy two-output models use configurable fallback uncertainty; that uncertainty is explicitly not learned. A heteroscedastic checkpoint can provide learned standard deviations.

## Constraints and leakage prevention

NHC measures body lateral and vertical velocity as zero with finite configurable standard deviations; it can be disabled. Road/route polylines are soft 2-D position measurements only: their covariance grows with cross-track residual and they release beyond a distance/heading gate. A route must be supplied before an outage; the evaluator does not create one from V.

`run_outage` processes samples in timestamp order and does not invoke GNSS updates inside `[start, end)`. It never accepts a V/reference argument. The M evaluation script derives its mounting transform only from a pre-outage calibration prefix. The leakage test changes reference/GNSS only after recovery and verifies every outage estimate is unchanged.

## Reproduction

From the repository root, install the research dependencies (the Expo client does not require them), then run:

```powershell
python -m pip install -r requirements-navigation.txt
python -m unittest discover -s research/idr/tests -v
python -m research.idr.evaluate_navigation --s "C:\Users\richi\Downloads\Navigation System\IO-VNBD\Synchronised V abd S datasets\Categorised IOVNB Dataset\M (Driver B)\S-M.csv" --v "C:\Users\richi\Downloads\Navigation System\IO-VNBD\Synchronised V abd S datasets\Categorised IOVNB Dataset\M (Driver B)\V-M.csv"
```

The evaluation compares ML+ESKF and ML+ESKF+NHC over 5, 10, 20, 30 and 60 second outages and writes RMSE, MAE and maximum horizontal position error. Road/route evaluation is deliberately opt-in until a route that was available before the outage is provided; treating the V trajectory as that route would invalidate the experiment.
