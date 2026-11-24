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

  const sampleCount = Math.min(14, coords.length);
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
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
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

/**
 * Decodes a Valhalla precision-6 encoded polyline into [lat, lon] pairs.
 */
export function decodePolyline6(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < encoded.length);
    const dLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dLat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < encoded.length);
    const dLon = result & 1 ? ~(result >> 1) : result >> 1;
    lon += dLon;

    coords.push([lat / 1e6, lon / 1e6]);
  }

  return coords;
}

/**
 * Computes the fraction (0..1) of sampled points in `coordsA` that lie within
 * `thresholdMeters` of any sampled point in `coordsB`.
 */
export function computePolylineOverlap(
  coordsA: [number, number][],
  coordsB: [number, number][],
  thresholdMeters = 60
): number {
  if (coordsA.length < 2 || coordsB.length < 2) return 0;

  const sample = (coords: [number, number][], count: number): LatLng[] => {
    const n = Math.min(count, coords.length);
    const pts: LatLng[] = [];
    for (let i = 0; i < n; i++) {
      const idx = Math.min(
        coords.length - 1,
        Math.round((i * (coords.length - 1)) / Math.max(1, n - 1))
      );
      pts.push({ lat: coords[idx][0], lon: coords[idx][1] });
    }
    return pts;
  };

  const ptsA = sample(coordsA, 32);
  const ptsB = sample(coordsB, 32);

  let matched = 0;
  for (const a of ptsA) {
    if (ptsB.some((b) => haversineMeters(a, b) <= thresholdMeters)) {
      matched++;
    }
  }
  return matched / ptsA.length;
}

/**
 * Counts how many distinct target points lie within `maxDistMeters` of a route polyline.
 */
export function countNearbyPoints(
  coords: [number, number][],
  targets: LatLng[],
  maxDistMeters: number
): number {
  if (coords.length < 2 || targets.length === 0) return 0;

  const n = Math.min(60, coords.length);
  const sampled: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(
      coords.length - 1,
      Math.round((i * (coords.length - 1)) / Math.max(1, n - 1))
    );
    sampled.push({ lat: coords[idx][0], lon: coords[idx][1] });
  }

  let count = 0;
  for (const target of targets) {
    if (sampled.some((pt) => haversineMeters(pt, target) <= maxDistMeters)) {
      count++;
    }
  }
  return count;
}
