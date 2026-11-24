import type { LatLng, ScenicPOI } from "./types";

const EARTH_RADIUS_M = 6371000;
const METERS_PER_MILE = 1609.344;

export function milesToMeters(miles: number): number {
  return miles * METERS_PER_MILE;
}

export function metersToMiles(meters: number): number {
  return meters / METERS_PER_MILE;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Computes a destination LatLng given start, distance in meters, and bearing in degrees (0 = North).
 */
export function destinationPoint(
  start: LatLng,
  distanceMeters: number,
  bearingDeg: number
): LatLng {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;

  const δ = distanceMeters / EARTH_RADIUS_M;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(start.lat);
  const λ1 = toRad(start.lon);

  const sinφ2 =
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const y = Math.sin(θ) * Math.sin(δ) * Math.cos(φ1);
  const x = Math.cos(δ) - Math.sin(φ1) * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);

  return {
    lat: toDeg(φ2),
    lon: ((toDeg(λ2) + 540) % 360) - 180,
  };
}

export function bearingDegrees(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Finds POIs from `pois` that lie within `maxDistMeters` of any sampled point on `coords`.
 */
export function findNearbyPOIs(
  coords: [number, number][],
  pois: ScenicPOI[],
  maxDistMeters = 260
): ScenicPOI[] {
  if (!coords.length || !pois.length) return [];
  // Sample ~30 points along the route for fast proximity checks
  const step = Math.max(1, Math.floor(coords.length / 30));
  const sampled: LatLng[] = [];
  for (let i = 0; i < coords.length; i += step) {
    sampled.push({ lat: coords[i][0], lon: coords[i][1] });
  }

  const matched: ScenicPOI[] = [];
  const seenNames = new Set<string>();

  for (const poi of pois) {
    if (!poi.name || seenNames.has(poi.name.toLowerCase())) continue;
    for (const pt of sampled) {
      if (haversineMeters(pt, poi) <= maxDistMeters) {
        matched.push(poi);
        seenNames.add(poi.name.toLowerCase());
        break;
      }
    }
  }
  return matched;
}

/**
 * Fetches elevation gain in feet via Open-Meteo's free keyless elevation API.
 * Samples up to 18 points along the route and returns total positive gain (ft) + terrain label.
 */
export async function fetchRouteElevationStats(
  coords: [number, number][],
  distanceMiles: number
): Promise<{
  elevationGainFt: number;
  terrainLabel: "Flat" | "Rolling" | "Hilly";
} | null> {
  if (coords.length < 2) return null;

  const sampleCount = Math.min(18, coords.length);
  const step = (coords.length - 1) / (sampleCount - 1);
  const lats: number[] = [];
  const lons: number[] = [];

  for (let i = 0; i < sampleCount; i++) {
    const idx = Math.min(coords.length - 1, Math.round(i * step));
    lats.push(Math.round(coords[idx][0] * 10000) / 10000);
    lons.push(Math.round(coords[idx][1] * 10000) / 10000);
  }

  try {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats.join(",")}&longitude=${lons.join(",")}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (!res.ok) return null;
    const data = (await res.json()) as { elevation?: number[] };
    const elevs = data.elevation;
    if (!Array.isArray(elevs) || elevs.length < 2) return null;

    let gainMeters = 0;
    for (let i = 1; i < elevs.length; i++) {
      const diff = elevs[i] - elevs[i - 1];
      if (diff > 2) {
        gainMeters += diff;
      }
    }

    const elevationGainFt = Math.round(gainMeters * 3.28084);
    const ftPerMile = distanceMiles > 0 ? elevationGainFt / distanceMiles : 0;
    const terrainLabel: "Flat" | "Rolling" | "Hilly" =
      ftPerMile < 40 ? "Flat" : ftPerMile <= 100 ? "Rolling" : "Hilly";

    return { elevationGainFt, terrainLabel };
  } catch {
    return null;
  }
}
