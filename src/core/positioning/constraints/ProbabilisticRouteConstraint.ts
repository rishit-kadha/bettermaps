/**
 * ProbabilisticRouteConstraint.ts
 *
 * Probabilistic soft route constraint engine.
 * Injects a priori route geometry into the 15-state ESKF via formal Kalman updates.
 *
 * Replaces external post-processing nudges with closed-form Bayesian observation updates:
 * z = p_route_proj - p_nom
 * H = [I_2, 0_{2x13}]
 * R = (sigma_base^2 + (kappa * d_perp)^2) * I_2
 */

import { Eskf } from "../eskf/Eskf";
import { wgs84ToEnu, Wgs84Coordinate } from "../coordinates";
import {
  NormalizedRoute,
  PreExistingRoute,
} from "../../navigation/routing/RoutingTypes";

export interface ProbabilisticRouteConstraintConfig {
  /** Base standard deviation in meters (sigma_base) */
  baseStdMeters: number;
  /** Covariance inflation slope with cross-track distance (kappa) */
  inflationFactor: number;
  /** Maximum cross-track distance before constraint gates off (meters) */
  maxCrossTrackMeters: number;
  /** Minimum heading cosine alignment required to apply constraint */
  minHeadingAlignmentCosine: number;
  /** Maximum allowable backwards along-track jump in meters */
  maxRetrogradeMeters: number;
}

export const DEFAULT_ROUTE_CONSTRAINT_CONFIG: ProbabilisticRouteConstraintConfig =
  {
    baseStdMeters: 8.0,
    inflationFactor: 0.5,
    maxCrossTrackMeters: 35.0,
    minHeadingAlignmentCosine: 0.0,
    maxRetrogradeMeters: 25.0,
  };

export interface RouteConstraintEvaluationResult {
  applied: boolean;
  targetEnu: [number, number];
  crossTrackDistanceM: number;
  alongTrackM: number;
  headingAlignmentCosine: number;
  rejectionReason?: string;
}

export class ProbabilisticRouteConstraint {
  private readonly config: ProbabilisticRouteConstraintConfig;
  private activeRoute: PreExistingRoute | null = null;
  private cachedEnuVertices: Array<{ east: number; north: number }> = [];
  private cachedCumulativeDistancesM: number[] = [];
  private cachedOrigin: Wgs84Coordinate | null = null;
  private lastAlongTrackM = 0.0;
  private isEnabled = true;
  private appliedUpdateCount = 0;

  constructor(config?: Partial<ProbabilisticRouteConstraintConfig>) {
    this.config = { ...DEFAULT_ROUTE_CONSTRAINT_CONFIG, ...config };
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
  }

  public getEnabled(): boolean {
    return this.isEnabled;
  }

  public getAppliedUpdateCount(): number {
    return this.appliedUpdateCount;
  }

  public setRoute(
    route: PreExistingRoute | null,
    originWgs?: Wgs84Coordinate,
  ): void {
    this.activeRoute = route;
    this.lastAlongTrackM = 0.0;
    this.cachedEnuVertices = [];
    this.cachedCumulativeDistancesM = [];
    this.cachedOrigin = null;

    if (route && originWgs) {
      this.cacheRouteEnu(route, originWgs);
    }
  }

  public getRoute(): PreExistingRoute | null {
    return this.activeRoute;
  }

  public reset(): void {
    this.lastAlongTrackM = 0.0;
    this.appliedUpdateCount = 0;
  }

  /**
   * Evaluates current ESKF position against the active route and applies a soft
   * Bayesian measurement update if all gating conditions pass.
   */
  public evaluateAndApply(
    eskf: Eskf,
    originWgs: Wgs84Coordinate,
  ): RouteConstraintEvaluationResult {
    const fallbackResult: RouteConstraintEvaluationResult = {
      applied: false,
      targetEnu: [0, 0],
      crossTrackDistanceM: 0,
      alongTrackM: this.lastAlongTrackM,
      headingAlignmentCosine: 1.0,
    };

    if (
      !this.isEnabled ||
      !this.activeRoute ||
      this.activeRoute.polylinePoints.length < 2
    ) {
      fallbackResult.rejectionReason =
        "Route constraint disabled or no active route";
      return fallbackResult;
    }

    // Ensure ENU cache is valid for this origin
    if (
      this.cachedEnuVertices.length === 0 ||
      !this.cachedOrigin ||
      this.cachedOrigin.latitude !== originWgs.latitude ||
      this.cachedOrigin.longitude !== originWgs.longitude
    ) {
      this.cacheRouteEnu(this.activeRoute, originWgs);
    }

    const state = eskf.getState();
    const currEast = state.positionEnu[0];
    const currNorth = state.positionEnu[1];
    const headingDeg = eskf.getHeadingDeg();
    const headingRad = (headingDeg * Math.PI) / 180.0;
    const vehicleHeadingUnit: [number, number] = [
      Math.sin(headingRad), // East component (+X)
      Math.cos(headingRad), // North component (+Y)
    ];

    // Find orthogonal projection onto the polyline
    const vertices = this.cachedEnuVertices;
    const cumDists = this.cachedCumulativeDistancesM;

    let bestDistSq = Infinity;
    let bestProjEast = currEast;
    let bestProjNorth = currNorth;
    let bestAlongTrackM = this.lastAlongTrackM;
    let bestSegmentBearingDeg = 0.0;

    for (let i = 0; i < vertices.length - 1; i++) {
      const p1 = vertices[i];
      const p2 = vertices[i + 1];

      const dx = p2.east - p1.east;
      const dy = p2.north - p1.north;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-4) continue;

      const segLen = Math.sqrt(lenSq);
      const px = currEast - p1.east;
      const py = currNorth - p1.north;
      const t = Math.max(0.0, Math.min(1.0, (px * dx + py * dy) / lenSq));

      const projE = p1.east + t * dx;
      const projN = p1.north + t * dy;
      const distSq =
        (currEast - projE) * (currEast - projE) +
        (currNorth - projN) * (currNorth - projN);

      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestProjEast = projE;
        bestProjNorth = projN;
        bestAlongTrackM = cumDists[i] + t * segLen;

        let bearing = (Math.atan2(dx, dy) * 180.0) / Math.PI;
        if (bearing < 0) bearing += 360.0;
        bestSegmentBearingDeg = bearing;
      }
    }

    const crossTrackDist = Math.sqrt(bestDistSq);

    // Gating 1: Cross-track distance
    if (crossTrackDist > this.config.maxCrossTrackMeters) {
      return {
        applied: false,
        targetEnu: [bestProjEast, bestProjNorth],
        crossTrackDistanceM: crossTrackDist,
        alongTrackM: bestAlongTrackM,
        headingAlignmentCosine: 0.0,
        rejectionReason: `Cross-track distance ${crossTrackDist.toFixed(1)}m exceeds threshold ${this.config.maxCrossTrackMeters}m`,
      };
    }

    // Gating 2: Heading alignment
    const segRad = (bestSegmentBearingDeg * Math.PI) / 180.0;
    const segHeadingUnit: [number, number] = [
      Math.sin(segRad),
      Math.cos(segRad),
    ];
    const headingAlignment =
      vehicleHeadingUnit[0] * segHeadingUnit[0] +
      vehicleHeadingUnit[1] * segHeadingUnit[1];

    if (headingAlignment < this.config.minHeadingAlignmentCosine) {
      return {
        applied: false,
        targetEnu: [bestProjEast, bestProjNorth],
        crossTrackDistanceM: crossTrackDist,
        alongTrackM: bestAlongTrackM,
        headingAlignmentCosine: headingAlignment,
        rejectionReason: `Heading alignment ${headingAlignment.toFixed(2)} below threshold ${this.config.minHeadingAlignmentCosine}`,
      };
    }

    // Gating 3: Retrograde motion check (cannot jump backwards significantly along route)
    if (
      bestAlongTrackM <
      this.lastAlongTrackM - this.config.maxRetrogradeMeters
    ) {
      return {
        applied: false,
        targetEnu: [bestProjEast, bestProjNorth],
        crossTrackDistanceM: crossTrackDist,
        alongTrackM: bestAlongTrackM,
        headingAlignmentCosine: headingAlignment,
        rejectionReason: `Retrograde along-track jump from ${this.lastAlongTrackM.toFixed(1)}m to ${bestAlongTrackM.toFixed(1)}m`,
      };
    }

    // All gates pass: execute soft Bayesian Kalman measurement update
    this.lastAlongTrackM = Math.max(this.lastAlongTrackM, bestAlongTrackM);

    eskf.updateSoftPosition(
      [bestProjEast, bestProjNorth],
      this.config.baseStdMeters,
      this.config.inflationFactor,
      true, // isRoute = true
    );
    this.appliedUpdateCount++;

    return {
      applied: true,
      targetEnu: [bestProjEast, bestProjNorth],
      crossTrackDistanceM: crossTrackDist,
      alongTrackM: bestAlongTrackM,
      headingAlignmentCosine: headingAlignment,
    };
  }

  private cacheRouteEnu(
    route: PreExistingRoute,
    originWgs: Wgs84Coordinate,
  ): void {
    this.cachedOrigin = { ...originWgs };
    this.cachedEnuVertices = [];
    this.cachedCumulativeDistancesM = [0.0];

    let totalDist = 0.0;
    for (let i = 0; i < route.polylinePoints.length; i++) {
      const p = route.polylinePoints[i];
      const enu = wgs84ToEnu(
        { latitude: p.latitude, longitude: p.longitude },
        originWgs,
      );
      this.cachedEnuVertices.push({ east: enu.east, north: enu.north });

      if (i > 0) {
        const prev = this.cachedEnuVertices[i - 1];
        const segDist = Math.hypot(
          enu.east - prev.east,
          enu.north - prev.north,
        );
        totalDist += segDist;
        this.cachedCumulativeDistancesM.push(totalDist);
      }
    }
  }
}
