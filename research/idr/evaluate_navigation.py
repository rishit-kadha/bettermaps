"""Causal M-session GNSS outage evaluation; V is metrics-only after preprocessing."""
from __future__ import annotations
import argparse, json
import numpy as np
import pandas as pd
from research.idr.models.tcn import TinyCausalTcnMotionModel
from research.idr.navigation.coordinates import wgs84_to_enu
from research.idr.navigation.eskf import ErrorStateKalmanFilter
from research.idr.navigation.motion_adapter import TorchMotionAdapter
from research.idr.navigation.outage import OutageConfig, run_outage
from research.idr.preprocessing.orientation import estimate_session_transform, transform_device_to_vehicle

def column(df, token): return next(c for c in df.columns if token.lower() in c.lower())

def repair_timestamp_resets(raw_ms):
    """Keep sample order, adding nominal 100 ms across a phone logger reset."""
    raw=np.asarray(raw_ms,float); fixed=np.empty_like(raw); fixed[0]=raw[0]; offset=0.
    for i in range(1,len(raw)):
        candidate=raw[i]+offset
        if candidate<=fixed[i-1]: offset=fixed[i-1]+100.-raw[i]; candidate=raw[i]+offset
        fixed[i]=candidate
    return fixed

def state_at_outage_start(t, gnss_enu, speed_kmh, start_s):
    """S-only GNSS hand-off: position, course and speed from history ending at start."""
    k=max(1,int(np.searchsorted(t,start_s,side='right')-1)); back=max(0,k-20)
    dp=gnss_enu[k]-gnss_enu[back]; dt=max(float(t[k]-t[back]),.1)
    horizontal=dp[:2]; distance=float(np.linalg.norm(horizontal))
    if distance>1.0: direction=horizontal/distance; speed=max(float(speed_kmh[k])/3.6,distance/dt)
    else: direction=np.array([1.,0.]); speed=max(0.,float(speed_kmh[k])/3.6)
    return gnss_enu[k], np.array([direction[0]*speed,direction[1]*speed,0.]), float(np.arctan2(direction[1],direction[0]))

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--s',required=True); p.add_argument('--v',required=True)
    p.add_argument('--checkpoint',default='artifacts/runs/B2_TCN/best_model.pt')
    p.add_argument('--normalization',default='artifacts/data/normalization.json')
    p.add_argument('--outages',default='5,10,20,30,60'); p.add_argument('--calibration-seconds',type=float,default=30.)
    p.add_argument('--output',default='artifacts/data/navigation_outage_summary.csv'); p.add_argument('--include-nhc',action='store_true',help='Evaluate NHC too; disabled by default until its mounting calibration is validated.')
    a=p.parse_args()
    s=pd.read_csv(a.s,encoding='latin1'); v=pd.read_csv(a.v,encoding='latin1'); s.columns=s.columns.str.strip(); v.columns=v.columns.str.strip(); n=min(len(s),len(v)); s,v=s.iloc[:n].reset_index(drop=True),v.iloc[:n].reset_index(drop=True)
    raw_time=s[column(s,'TIME SINCE START')].to_numpy(float); t=(repair_timestamp_resets(raw_time)-raw_time[0])/1000.
    cal=min(n,max(200,int(a.calibration_seconds*10))); R=estimate_session_transform(s.iloc[:cal],v.iloc[:cal])['R_D_to_V']; imu=transform_device_to_vehicle(s,R)
    with open(a.normalization) as f: norm=json.load(f)
    import torch
    ckpt=torch.load(a.checkpoint,map_location='cpu',weights_only=False); model=TinyCausalTcnMotionModel(); model.load_state_dict(ckpt['model_state']); predictor=TorchMotionAdapter(model,np.array(norm['mean']),np.array(norm['std']))
    # S establishes both local origin and online GNSS updates. V remains metrics only.
    s_lat=s[column(s,'GPS LATITUDE')].to_numpy(float); s_lon=s[column(s,'GPS LONGITUDE')].to_numpy(float); origin=(s_lat[0],s_lon[0]); gnss=np.array([wgs84_to_enu(x,y,*origin) for x,y in zip(s_lat,s_lon)])
    speed=s[column(s,'GPS SPEED')].to_numpy(float); v_lat=v[column(v,'Latitude')].to_numpy(float); v_lon=v[column(v,'Longitude')].to_numpy(float); ref=np.array([wgs84_to_enu(x,y,*origin) for x,y in zip(v_lat,v_lon)])
    methods=[('ml_eskf',False)]+([('ml_eskf_nhc',True)] if a.include_nhc else []); records=[]
    for dur in map(float,a.outages.split(',')):
        start=max(a.calibration_seconds+2.,t[20]); end=start+dur; keep=t<=end; p0,v0,h0=state_at_outage_start(t,gnss,speed,start)
        for name,nhc in methods:
            config=OutageConfig(start,dur,use_nhc=nhc,initial_position_enu=p0,initial_velocity_enu_mps=v0,initial_heading_enu_rad=h0)
            est=run_outage(t[keep],imu[keep],predictor,ErrorStateKalmanFilter(),config,gnss[keep]); m=(t[keep]>=start)&(t[keep]<end); err=np.linalg.norm(est[m,:2]-ref[keep][m,:2],axis=1)
            records.append(dict(method=name,outage_duration_s=dur,samples=int(m.sum()),horizontal_rmse_m=float(np.sqrt(np.mean(err**2))),horizontal_mae_m=float(np.mean(err)),max_position_error_m=float(np.max(err))))
    out=pd.DataFrame(records); out.to_csv(a.output,index=False); print(out.to_string(index=False)); print(f'Wrote {a.output}')
if __name__=='__main__': main()
