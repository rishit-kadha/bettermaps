/**
 * Google Places API Integration Service
 *
 * Implements:
 * 1. Google Places Autocomplete with session tokens to minimize billing costs.
 * 2. Location biasing towards current vehicle coordinates.
 * 3. Place Details retrieval for destination coordinates.
 * 4. Android package & cert headers for mobile authentication.
 */

import { RoutePoint } from "../../core/types/navigation";

export interface PlacePrediction {
  placeId: string;
  primaryText: string;
  secondaryText: string;
  fullText: string;
}

export interface PlaceDetails {
  placeId: string;
  name: string;
  address: string;
  coordinate: RoutePoint;
}

/**
 * Generates a standard UUID v4 string for Places API session tokens.
 */
export function generateSessionToken(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getApiKey(): string {
  const key =
    process.env.EXPO_PUBLIC_GOOGLE_SERVICES_API_KEY ||
    process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ||
    "";
  return key.trim();
}

function getRequestHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Android-Package": "com.sih.bettermaps",
    "X-Android-Cert": "5E8F16062EA3CD2C4A0D547876BAA6F38CABF625",
  };
}

/**
 * Fetches autocomplete suggestions from Google Places Autocomplete API.
 * Uses session token according to Google's billing best practices.
 */
export async function fetchPlacePredictions(
  input: string,
  userLocation: RoutePoint | null,
  sessionToken: string,
): Promise<{ predictions: PlacePrediction[]; error?: string }> {
  if (!input || input.trim().length < 2) {
    return { predictions: [] };
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      predictions: [],
      error: "Google Maps/Services API key is not configured in .env",
    };
  }

  try {
    let url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(
      input.trim(),
    )}&key=${apiKey}&sessiontoken=${sessionToken}`;

    if (userLocation) {
      url += `&location=${userLocation.latitude},${userLocation.longitude}&radius=50000`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers: getRequestHeaders(),
    });

    const data = await response.json();

    if (data.status === "OK" && Array.isArray(data.predictions)) {
      const predictions: PlacePrediction[] = data.predictions.map((p: any) => ({
        placeId: p.place_id,
        primaryText:
          p.structured_formatting?.main_text ||
          p.description?.split(",")[0] ||
          "",
        secondaryText:
          p.structured_formatting?.secondary_text ||
          p.description?.split(",").slice(1).join(",") ||
          "",
        fullText: p.description,
      }));

      return { predictions };
    }

    if (data.status === "ZERO_RESULTS") {
      return { predictions: [] };
    }

    // Handle Google Cloud API error (e.g. REQUEST_DENIED, OVER_QUERY_LIMIT)
    const errorMsg =
      data.error_message || data.status || "Failed to search places";
    return { predictions: [], error: errorMsg };
  } catch (err: any) {
    return {
      predictions: [],
      error: `Network error connecting to Places API: ${err.message}`,
    };
  }
}

/**
 * Retrieves precise destination coordinates and address from Place Details API.
 * Concludes the session token lifecycle.
 */
export async function fetchPlaceDetails(
  placeId: string,
  sessionToken: string,
): Promise<{ details: PlaceDetails | null; error?: string }> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      details: null,
      error: "Google Maps/Services API key is not configured in .env",
    };
  }

  try {
    const fields = "name,formatted_address,geometry";
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${apiKey}&sessiontoken=${sessionToken}`;

    const response = await fetch(url, {
      method: "GET",
      headers: getRequestHeaders(),
    });

    const data = await response.json();

    if (data.status === "OK" && data.result?.geometry?.location) {
      const loc = data.result.geometry.location;
      return {
        details: {
          placeId,
          name: data.result.name || "Selected Destination",
          address: data.result.formatted_address || "",
          coordinate: {
            latitude: loc.lat,
            longitude: loc.lng,
          },
        },
      };
    }

    const errorMsg =
      data.error_message || data.status || "Failed to get place details";
    return { details: null, error: errorMsg };
  } catch (err: any) {
    return {
      details: null,
      error: `Network error retrieving place details: ${err.message}`,
    };
  }
}
