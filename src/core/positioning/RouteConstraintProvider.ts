/**
 * RouteConstraintProvider
 *
 * Soft, Bounded Route Constraint Provider for Dead Reckoning Navigation.
 *
 * ARCHITECTURAL PRINCIPLE:
 * 1. The route constraint operates as an external post-processing navigation constraint.
 *    It is strictly decoupled from the local vehicle-motion estimator (IMotionEstimator).
 * 2. It consumes a static a priori route polyline (e.g. planned navigation route).
 *    In Experiment R1, the route polyline is fixed prior to the outage; it is NEVER
 *    dynamically updated from future reference GPS.
 * 3. It DOES NOT hard-snap coordinates. Instead, it computes an uncertainty-weighted
 *    Bayesian attraction bounded by a maximum correction cap (delta_max) per update.
 * 4. It automatically releases (w -> 0) if cross-track distance exceeds threshold
 *    or if vehicle heading is incompatible with route segment direction.
 */

import {
  enuToWgs84,
  haversineDistance,
  wgs84ToEnu,
  Wgs84Coordinate,
} from "./coordinates";
import { PositionEstimate } from "../types/positioning";

export interface RouteConstraintConfig {
  /** Maximum cross-track distance before constraint releases (meters) */
  maxCrossTrackMeters?: number;
  /** Characteristic cross-track attraction width (meters) */
  sigmaRouteMeters?: number;
  /** Maximum allowable displacement correction per update (meters) to prevent teleportation */
  maxCorrectionPerUpdateMeters?: number;
  /** Proportional attraction strength factor (0.0 to 1.0) */
  pullFactor?: number;
  /** Minimum heading cosine alignment required to apply constraint */
  minHeadingAlignment?: number;
}

export interface ConstraintResult {
  constrainedEstimate: PositionEstimate;
  crossTrackDistanceMeters: number;
  headingAlignment: number;
  appliedCorrectionMeters: number;
  constraintActive: boolean;
}

export class RouteConstraintProvider {
  private config: Required<RouteConstraintConfig>;
  private isEnabled = true;

  constructor(config?: RouteConstraintConfig) {
    this.config = {
      maxCrossTrackMeters: config?.maxCrossTrackMeters ?? 30.0,
      sigmaRouteMeters: config?.sigmaRouteMeters ?? 15.0,
      maxCorrectionPerUpdateMeters: config?.maxCorrectionPerUpdateMeters ?? 0.5,
      pullFactor: config?.pullFactor ?? 0.4,
      minHeadingAlignment: config?.minHeadingAlignment ?? 0.2,
    };
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
  }

  public getEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Evaluates unconstrained dead-reckoning position against a static route polyline.
   *
   * @param unconstrained Raw dead-reckoning position estimate
   * @param routePoints Static array of route coordinates (WGS84)
   * @param origin Local ENU origin coordinate
   */
  public applyConstraint(
    unconstrained: PositionEstimate,
    routePoints: { latitude: number; longitude: number }[],
    origin: Wgs84Coordinate,
  ): ConstraintResult {
    // If constraint disabled or route invalid, return unconstrained directly
    if (!this.isEnabled || routePoints.length < 2) {
      return {
        constrainedEstimate: unconstrained,
        crossTrackDistanceMeters: 0,
        headingAlignment: 1.0,
        appliedCorrectionMeters: 0,
        constraintActive: false,
      };
    }

    // 1. Project unconstrained position to local ENU frame
    const posEnu = wgs84ToEnu(
      {
        latitude: unconstrained.latitude,
        longitude: unconstrained.longitude,
      },
      origin,
    );

    // 2. Find nearest segment on the route polyline in ENU
    let minDistanceSq = Infinity;
    let bestProj = { east: posEnu.east, north: posEnu.north };
    let bestSegmentHeadingDeg = 0;

    for (let i = 0; i < routePoints.length - 1; i++) {
      const p1 = wgs84ToEnu(routePoints[i], origin);
      const p2 = wgs84ToEnu(routePoints[i + 1], origin);

      const dx = p2.east - p1.east;
      const dy = p2.north - p1.north;
      const lenSq = dx * dx + dy * dy;

      if (lenSq < 1e-6) continue;

      // Project posEnu onto segment p1-p2
      const t = Math.max(
        0.0,
        Math.min(
          1.0,
          ((posEnu.east - p1.east) * dx + (posEnu.north - p1.north) * dy) /
            lenSq,
        ),
      );

      const projEast = p1.east + t * dx;
      const projNorth = p1.north + t * dy;

      const distSq =
        (posEnu.east - projEast) * (posEnu.east - projEast) +
        (posEnu.north - projNorth) * (posEnu.north - projNorth);

      if (distSq < minDistanceSq) {
        minDistanceSq = distSq;
        bestProj = { east: projEast, north: projNorth };
        // Bearing of the segment in degrees (clockwise from North)
        bestSegmentHeadingDeg = (Math.atan2(dx, dy) * 180.0) / Math.PI;
        if (bestSegmentHeadingDeg < 0) bestSegmentHeadingDeg += 360.0;
      }
    }

    const crossTrackDist = Math.sqrt(minDistanceSq);

    // 3. Evaluate heading compatibility
    const vehicleHeading = unconstrained.heading ?? 0;
    const headingDiffRad =
      ((vehicleHeading - bestSegmentHeadingDeg) * Math.PI) / 180.0;
    const headingAlignment = Math.cos(headingDiffRad);

    // 4. Gating checks: release if cross-track too large or heading incompatible
    const isHeadingCompatible =
      headingAlignment >= this.config.minHeadingAlignment;
    const isWithinCrossTrack =
      crossTrackDist <= this.config.maxCrossTrackMeters;

    if (!isHeadingCompatible || !isWithinCrossTrack) {
      return {
        constrainedEstimate: unconstrained,
        crossTrackDistanceMeters: crossTrackDist,
        headingAlignment,
        appliedCorrectionMeters: 0,
        constraintActive: false,
      };
    }

    // 5. Calculate soft Gaussian attraction weight
    const gaussianAttraction = Math.exp(
      -(crossTrackDist * crossTrackDist) /
        (2.0 * this.config.sigmaRouteMeters * this.config.sigmaRouteMeters),
    );
    const weight =
      gaussianAttraction *
      Math.max(0.0, headingAlignment) *
      this.config.pullFactor;

    // 6. Compute raw correction vector
    const rawDeltaEast = weight * (bestProj.east - posEnu.east);
    const rawDeltaNorth = weight * (bestProj.north - posEnu.north);
    const rawDeltaNorm = Math.sqrt(
      rawDeltaEast * rawDeltaEast + rawDeltaNorth * rawDeltaNorth,
    );

    // 7. Enforce maximum displacement correction cap per update (no teleportation)
    let boundedDeltaEast = rawDeltaEast;
    let boundedDeltaNorth = rawDeltaNorth;
    let appliedCorrection = rawDeltaNorm;

    if (rawDeltaNorm > this.config.maxCorrectionPerUpdateMeters) {
      const scale = this.config.maxCorrectionPerUpdateMeters / rawDeltaNorm;
      boundedDeltaEast *= scale;
      boundedDeltaNorth *= scale;
      appliedCorrection = this.config.maxCorrectionPerUpdateMeters;
    }

    // 8. Compute final constrained ENU position
    const constrainedEnu = {
      east: posEnu.east + boundedDeltaEast,
      north: posEnu.north + boundedDeltaNorth,
      up: posEnu.up,
    };

    // 9. Convert back to WGS84 coordinates
    const constrainedWgs = enuToWgs84(constrainedEnu, origin);

    const constrainedEstimate: PositionEstimate = {
      ...unconstrained,
      latitude: constrainedWgs.latitude,
      longitude: constrainedWgs.longitude,
    };

    return {
      constrainedEstimate,
      crossTrackDistanceMeters: crossTrackDist,
      headingAlignment,
      appliedCorrectionMeters: appliedCorrection,
      constraintActive: true,
    };
  }
}
