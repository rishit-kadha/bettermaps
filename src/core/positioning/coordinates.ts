/**
 * Coordinate Geometry & Local Tangent Plane (ENU) Utilities
 *
 * Provides mathematically rigorous conversion between WGS84 ellipsoidal
 * geographic coordinates (latitude, longitude in degrees) and a local
 * metric East-North-Up (ENU) tangent plane frame.
 *
 * CRITICAL RESEARCH RULE:
 * Dead-reckoning position integration MUST occur in local metric coordinates (meters),
 * NEVER by directly integrating latitude/longitude degrees as if they were meters.
 */

// WGS84 Ellipsoid constants
const WGS84_A = 6378137.0; // Semi-major axis in meters
const WGS84_F = 1.0 / 298.257223563; // Flattening
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F; // First eccentricity squared (~0.00669438)

export interface EnuCoordinate {
  east: number; // x in meters (+East)
  north: number; // y in meters (+North)
  up?: number; // z in meters (+Up)
}

export interface Wgs84Coordinate {
  latitude: number; // degrees (-90 to +90)
  longitude: number; // degrees (-180 to +180)
  altitude?: number | null; // meters
}

/**
 * Converts a WGS84 coordinate to local metric East-North-Up (ENU) coordinates
 * relative to an established local origin (e.g. initial reference position).
 */
export function wgs84ToEnu(
  coord: Wgs84Coordinate,
  origin: Wgs84Coordinate,
): EnuCoordinate {
  const phi0 = (origin.latitude * Math.PI) / 180.0;
  const phi = (coord.latitude * Math.PI) / 180.0;
  const lambda0 = (origin.longitude * Math.PI) / 180.0;
  const lambda = (coord.longitude * Math.PI) / 180.0;

  const sinPhi0 = Math.sin(phi0);
  const sin2Phi0 = sinPhi0 * sinPhi0;
  const denom = Math.sqrt(1.0 - WGS84_E2 * sin2Phi0);

  // Meridional radius of curvature (North-South)
  const rLat = (WGS84_A * (1.0 - WGS84_E2)) / (denom * denom * denom);

  // Prime vertical radius of curvature (East-West)
  const rLon = (WGS84_A * Math.cos(phi0)) / denom;

  const east = (lambda - lambda0) * rLon;
  const north = (phi - phi0) * rLat;
  const up = (coord.altitude ?? 0) - (origin.altitude ?? 0);

  return { east, north, up };
}

/**
 * Converts local metric East-North-Up (ENU) coordinates back to WGS84 geographic coordinates.
 */
export function enuToWgs84(
  enu: EnuCoordinate,
  origin: Wgs84Coordinate,
): Wgs84Coordinate {
  const phi0 = (origin.latitude * Math.PI) / 180.0;
  const lambda0 = (origin.longitude * Math.PI) / 180.0;

  const sinPhi0 = Math.sin(phi0);
  const sin2Phi0 = sinPhi0 * sinPhi0;
  const denom = Math.sqrt(1.0 - WGS84_E2 * sin2Phi0);

  const rLat = (WGS84_A * (1.0 - WGS84_E2)) / (denom * denom * denom);
  const rLon = (WGS84_A * Math.cos(phi0)) / denom;

  const deltaPhi = enu.north / rLat;
  const deltaLambda = enu.east / rLon;

  const latitude = ((phi0 + deltaPhi) * 180.0) / Math.PI;
  const longitude = ((lambda0 + deltaLambda) * 180.0) / Math.PI;
  const altitude =
    origin.altitude !== null && origin.altitude !== undefined
      ? origin.altitude + (enu.up ?? 0)
      : null;

  return { latitude, longitude, altitude };
}

/**
 * Computes great-circle Haversine distance in meters between two WGS84 coordinates.
 */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000.0; // Earth mean radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180.0;
  const dLon = ((lon2 - lon1) * Math.PI) / 180.0;
  const phi1 = (lat1 * Math.PI) / 180.0;
  const phi2 = (lat2 * Math.PI) / 180.0;

  const a =
    Math.sin(dLat / 2.0) * Math.sin(dLat / 2.0) +
    Math.cos(phi1) *
      Math.cos(phi2) *
      Math.sin(dLon / 2.0) *
      Math.sin(dLon / 2.0);

  const c = 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
  return R * c;
}

/**
 * Computes initial compass bearing in degrees (0 - 360, clockwise from True North).
 */
export function bearingBetween(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const phi1 = (lat1 * Math.PI) / 180.0;
  const phi2 = (lat2 * Math.PI) / 180.0;
  const dLon = ((lon2 - lon1) * Math.PI) / 180.0;

  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);

  const brng = (Math.atan2(y, x) * 180.0) / Math.PI;
  return (brng + 360.0) % 360.0;
}
