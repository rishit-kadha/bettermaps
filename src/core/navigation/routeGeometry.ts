/**
 * Route Geometry Engine for BetterMaps.
 *
 * Implements mathematically rigorous:
 * 1. Great-circle Haversine distances.
 * 2. Cumulative arc-length metric calculation along route polyline vertices.
 * 3. Orthogonal projection of vehicle position onto polyline segments.
 * 4. Monotonic along-track progress tracking with cross-track deviation detection.
 * 5. Cumulative threshold-based step and maneuver advancement.
 */

import { NavLocation } from "../types/location";
import {
  ActiveRoute,
  RouteGeometry,
  RoutePoint,
  RouteProgress,
  RouteStep,
} from "../types/navigation";

const EARTH_RADIUS_METERS = 6371008.8;

/**
 * High-precision Haversine formula calculating distance between two WGS84 coordinates in meters.
 */
export function haversineDistance(p1: RoutePoint, p2: RoutePoint): number {
  const toRad = Math.PI / 180;
  const dLat = (p2.latitude - p1.latitude) * toRad;
  const dLon = (p2.longitude - p1.longitude) * toRad;
  const lat1 = p1.latitude * toRad;
  const lat2 = p2.latitude * toRad;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

/**
 * Computes cumulative arc-length distances in meters at each vertex of a polyline path.
 */
export function buildRouteGeometry(points: RoutePoint[]): RouteGeometry {
  if (points.length === 0) {
    return { points: [], cumulativeDistances: [0], totalLengthMeters: 0 };
  }

  const cumulativeDistances: number[] = [0];
  let totalLength = 0;

  for (let i = 1; i < points.length; i++) {
    const dist = haversineDistance(points[i - 1], points[i]);
    totalLength += dist;
    cumulativeDistances.push(totalLength);
  }

  return {
    points,
    cumulativeDistances,
    totalLengthMeters: totalLength,
  };
}

/**
 * Projects a point onto a line segment in a local equirectangular projection.
 * Returns the clamped interpolation fraction t [0, 1] and orthogonal cross-track distance in meters.
 */
function projectPointOnSegment(
  p: RoutePoint,
  a: RoutePoint,
  b: RoutePoint,
): { t: number; projected: RoutePoint; distanceMeters: number } {
  const midLatRad = ((a.latitude + b.latitude) / 2) * (Math.PI / 180);
  const cosMidLat = Math.cos(midLatRad);

  // Convert degree differences to local metric displacements (meters)
  const degToMetersLat = 111132.95;
  const degToMetersLon = 111412.84 * cosMidLat;

  const dx = (b.longitude - a.longitude) * degToMetersLon;
  const dy = (b.latitude - a.latitude) * degToMetersLat;

  const segLengthSq = dx * dx + dy * dy;

  if (segLengthSq < 0.001) {
    // Segment is virtually a single point
    return {
      t: 0,
      projected: { latitude: a.latitude, longitude: a.longitude },
      distanceMeters: haversineDistance(p, a),
    };
  }

  const px = (p.longitude - a.longitude) * degToMetersLon;
  const py = (p.latitude - a.latitude) * degToMetersLat;

  const dot = px * dx + py * dy;
  const t = Math.max(0, Math.min(1, dot / segLengthSq));

  const projected: RoutePoint = {
    latitude: a.latitude + t * (b.latitude - a.latitude),
    longitude: a.longitude + t * (b.longitude - a.longitude),
  };

  const distanceMeters = haversineDistance(p, projected);

  return { t, projected, distanceMeters };
}

/**
 * Calculates real-time route progress along the cumulative route geometry.
 *
 * Guaranteed properties:
 * - Distance traveled progresses monotonically forward along the route geometry.
 * - Handles curved polyline roads without Euclidean jump artifacts.
 * - Transitions step maneuvers when vehicle crosses cumulative arc-length thresholds.
 * - Works identically whether location is provided by GNSS or future IDR engine.
 */
export function calculateRouteProgress(
  route: ActiveRoute,
  currentLocation: NavLocation,
  previousProgress: RouteProgress | null,
): RouteProgress {
  const { geometry, steps, metadata } = route;
  const { points, cumulativeDistances, totalLengthMeters } = geometry;

  if (points.length < 2 || totalLengthMeters <= 0) {
    return createInitialProgress(route);
  }

  const currentPoint: RoutePoint = {
    latitude: currentLocation.latitude,
    longitude: currentLocation.longitude,
  };

  // Find the closest projection along the polyline segments
  let bestDistance = Infinity;
  let bestAlongTrackDistance = previousProgress?.distanceTraveledMeters ?? 0;

  // Optimize search: if previous progress exists, search in a localized window around previous segment
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segStartDistance = cumulativeDistances[i];
    const segEndDistance = cumulativeDistances[i + 1];

    const { t, distanceMeters } = projectPointOnSegment(currentPoint, a, b);

    // Calculate candidate along-track distance
    const candidateAlongTrack =
      segStartDistance + t * (segEndDistance - segStartDistance);

    // Penalize searching backward from already traveled distance (hysteresis)
    const backwardPenalty =
      previousProgress &&
      candidateAlongTrack < previousProgress.distanceTraveledMeters - 20
        ? 100
        : 0;

    const effectiveScore = distanceMeters + backwardPenalty;

    if (effectiveScore < bestDistance) {
      bestDistance = distanceMeters;
      bestAlongTrackDistance = candidateAlongTrack;
    }
  }

  // Enforce forward monotonicity (prevent jitter backward on GPS noise when stationary)
  const prevTraveled = previousProgress?.distanceTraveledMeters ?? 0;
  const distanceTraveledMeters = Math.min(
    totalLengthMeters,
    Math.max(prevTraveled, bestAlongTrackDistance),
  );

  const remainingDistanceMeters = Math.max(
    0,
    totalLengthMeters - distanceTraveledMeters,
  );

  // Check destination arrival (within 25m of destination or remaining distance < 20m)
  const distanceToDestDirect = haversineDistance(
    currentPoint,
    metadata.destinationCoordinate,
  );
  const isArrived = remainingDistanceMeters < 20 || distanceToDestDirect < 25;

  // Determine current step by matching cumulative arc-length
  let currentStepIndex = 0;
  let nextManeuver: RouteStep | null = null;
  let distanceToManeuverMeters = 0;

  if (steps.length > 0) {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      // Step is active if our along-track distance hasn't reached its completion boundary
      if (distanceTraveledMeters < step.endDistanceAlongRoute) {
        currentStepIndex = i;
        nextManeuver = step;
        distanceToManeuverMeters = Math.max(
          0,
          step.endDistanceAlongRoute - distanceTraveledMeters,
        );
        break;
      }
    }

    if (!nextManeuver && steps.length > 0) {
      currentStepIndex = steps.length - 1;
      nextManeuver = steps[steps.length - 1];
      distanceToManeuverMeters = 0;
    }
  }

  // Calculate remaining duration and ETA
  const fractionRemaining =
    totalLengthMeters > 0 ? remainingDistanceMeters / totalLengthMeters : 0;
  const remainingDurationSeconds = Math.round(
    metadata.totalDurationSeconds * fractionRemaining,
  );

  const etaDate = new Date(Date.now() + remainingDurationSeconds * 1000);
  const etaClock = formatClockTime(etaDate);

  // Off-route check: cross-track deviation > 45 meters
  const isOffRoute = bestDistance > 45;

  return {
    distanceTraveledMeters,
    remainingDistanceMeters,
    remainingDurationSeconds,
    etaClock,
    currentStepIndex,
    distanceToManeuverMeters,
    nextManeuver,
    crossTrackDistanceMeters: Math.round(bestDistance),
    isOffRoute,
    isArrived,
  };
}

/**
 * Creates initial progress state at the beginning of a route preview.
 */
export function createInitialProgress(route: ActiveRoute): RouteProgress {
  const totalLength = route.geometry.totalLengthMeters;
  const totalDuration = route.metadata.totalDurationSeconds;
  const firstStep = route.steps.length > 0 ? route.steps[0] : null;

  const etaDate = new Date(Date.now() + totalDuration * 1000);

  return {
    distanceTraveledMeters: 0,
    remainingDistanceMeters: totalLength,
    remainingDurationSeconds: totalDuration,
    etaClock: formatClockTime(etaDate),
    currentStepIndex: 0,
    distanceToManeuverMeters: firstStep
      ? firstStep.endDistanceAlongRoute
      : totalLength,
    nextManeuver: firstStep,
    crossTrackDistanceMeters: 0,
    isOffRoute: false,
    isArrived: false,
  };
}

function formatClockTime(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12; // '0' becomes '12'
  const minStr = minutes < 10 ? `0${minutes}` : `${minutes}`;
  return `${hours}:${minStr} ${ampm}`;
}
