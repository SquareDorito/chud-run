import type { RunRoute, ScenicPOI } from "./types";

/**
 * Compact payload stored for shared routes (server-backed `/r/[id]` or legacy `?d=...`).
 */
export interface SharedRoutePayload {
  id: string;
  name: string;
  tagline: string;
  mode: "loop" | "point-to-point";
  distanceMiles: number;
  estimatedMinutes: number;
  elevationGainFt?: number;
  terrainLabel?: "Flat" | "Rolling" | "Hilly";
  trafficFreePct: number;
  sceneryScore: number;
  nightScore?: number;
  nightLabel?: "Well Lit" | "Moderate Light" | "Low Light";
  uniquePathPct?: number;
  trafficLights?: number;
  waterFountains?: number;
  restrooms?: number;
  lapInfo?: {
    laps: number;
    featureName: string;
    kind: "track" | "park-loop";
  };
  carFreePct: number;
  quietStreetPct: number;
  mainRoadPct: number;
  highlights: string[];
  startLabel: string;
  startFullLabel?: string;
  startLat: number;
  startLon: number;
  endLabel: string;
  endFullLabel?: string;
  endLat: number;
  endLon: number;
  endRating?: number;
  endRatingCount?: number;
  foodOrArea?: string;
  pois?: ScenicPOI[];
  /** Downsampled [lat, lon] pairs rounded to 4 decimals (~11m precision) */
  coords: [number, number][];
}

export function downsampleCoordinates(
  coords: [number, number][],
  maxPoints = 48
): [number, number][] {
  if (coords.length <= maxPoints) {
    return coords.map(([lat, lon]) => [
      Math.round(lat * 10000) / 10000,
      Math.round(lon * 10000) / 10000,
    ]);
  }
  const step = (coords.length - 1) / (maxPoints - 1);
  const result: [number, number][] = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(coords.length - 1, Math.round(i * step));
    const [lat, lon] = coords[idx];
    result.push([
      Math.round(lat * 10000) / 10000,
      Math.round(lon * 10000) / 10000,
    ]);
  }
  return result;
}

export function toSharedRoutePayload(
  route: RunRoute,
  maxPoints = 160
): SharedRoutePayload {
  return {
    id: route.id,
    name: route.name,
    tagline: route.tagline,
    mode: route.mode,
    distanceMiles: Math.round(route.distanceMiles * 100) / 100,
    estimatedMinutes: route.estimatedMinutes,
    elevationGainFt: route.elevationGainFt,
    terrainLabel: route.terrainLabel,
    trafficFreePct: route.trafficFreePct,
    sceneryScore: route.sceneryScore,
    nightScore: route.nightScore,
    nightLabel: route.nightLabel,
    uniquePathPct: route.uniquePathPct,
    trafficLights: route.trafficLights,
    waterFountains: route.waterFountains,
    restrooms: route.restrooms,
    lapInfo: route.lapInfo,
    carFreePct: route.surfaceBreakdown.carFreePct,
    quietStreetPct: route.surfaceBreakdown.quietStreetPct,
    mainRoadPct: route.surfaceBreakdown.mainRoadPct,
    highlights: route.highlights.slice(0, 4),
    startLabel: route.start.shortName,
    startFullLabel:
      route.start.label && route.start.label !== route.start.shortName
        ? route.start.label
        : undefined,
    startLat: Math.round(route.start.lat * 10000) / 10000,
    startLon: Math.round(route.start.lon * 10000) / 10000,
    endLabel: route.end.shortName,
    endFullLabel:
      route.end.label && route.end.label !== route.end.shortName
        ? route.end.label
        : undefined,
    endLat: Math.round(route.end.lat * 10000) / 10000,
    endLon: Math.round(route.end.lon * 10000) / 10000,
    endRating: route.end.rating,
    endRatingCount: route.end.ratingCount,
    foodOrArea: route.destinationFoodOrArea,
    pois: (route.pois || []).slice(0, 5),
    coords: downsampleCoordinates(route.coordinates, maxPoints),
  };
}

export function payloadToRunRoute(p: SharedRoutePayload): RunRoute | null {
  if (!p || !Array.isArray(p.coords) || p.coords.length < 2) return null;

  return {
    id: p.id || "shared",
    name: p.name || "Scenic Running Route",
    tagline: p.tagline || "Traffic-free scenic run",
    mode: p.mode || "loop",
    distanceMiles: p.distanceMiles,
    estimatedMinutes: p.estimatedMinutes,
    elevationGainFt: p.elevationGainFt,
    terrainLabel: p.terrainLabel,
    trafficFreePct: p.trafficFreePct,
    sceneryScore: p.sceneryScore,
    nightScore: p.nightScore,
    nightLabel: p.nightLabel,
    uniquePathPct: p.uniquePathPct,
    trafficLights: p.trafficLights,
    waterFountains: p.waterFountains,
    restrooms: p.restrooms,
    lapInfo: p.lapInfo,
    surfaceBreakdown: {
      carFreePct: p.carFreePct ?? p.trafficFreePct,
      quietStreetPct: p.quietStreetPct ?? Math.max(0, 100 - p.trafficFreePct),
      mainRoadPct: p.mainRoadPct ?? 0,
    },
    highlights: p.highlights || [],
    start: {
      label: p.startFullLabel || p.startLabel,
      shortName: p.startLabel,
      lat: p.startLat,
      lon: p.startLon,
    },
    end: {
      label: p.endFullLabel || p.endLabel,
      shortName: p.endLabel,
      lat: p.endLat,
      lon: p.endLon,
      rating: p.endRating,
      ratingCount: p.endRatingCount,
    },
    destinationFoodOrArea: p.foodOrArea,
    coordinates: p.coords,
    pois: p.pois || [],
  };
}

export function encodeRouteToToken(route: RunRoute): string {
  const payload = toSharedRoutePayload(route, 48);
  const json = JSON.stringify(payload);
  // UTF-8 safe base64url encoding (works in Node and all browsers; avoids Buffer polyfill lacking "base64url")
  if (typeof Buffer !== "undefined" && typeof window === "undefined") {
    return Buffer.from(json, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeRouteFromToken(token: string): RunRoute | null {
  try {
    const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    let json: string;
    if (typeof Buffer !== "undefined" && typeof window === "undefined") {
      json = Buffer.from(padded, "base64").toString("utf8");
    } else {
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      json = new TextDecoder().decode(bytes);
    }

    const p = JSON.parse(json) as SharedRoutePayload;
    return payloadToRunRoute(p);
  } catch {
    return null;
  }
}

export function generateGPX(route: RunRoute): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const trkpts = route.coordinates
    .map(([lat, lon]) => `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ChudRun" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${esc(route.name)}</name>
    <desc>${esc(route.tagline)} (${route.distanceMiles.toFixed(2)} mi, ${route.trafficFreePct}% traffic-free)</desc>
  </metadata>
  <trk>
    <name>${esc(route.name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

function sampleIntermediateWaypoints(
  coords: [number, number][],
  count: number
): [number, number][] {
  if (coords.length <= 2) return [];
  const pts: [number, number][] = [];
  for (let i = 1; i <= count; i++) {
    const idx = Math.min(
      coords.length - 2,
      Math.max(1, Math.round((i * (coords.length - 1)) / (count + 1)))
    );
    pts.push(coords[idx]);
  }
  return pts;
}

export function buildGoogleMapsWalkingUrl(route: RunRoute): string {
  const origin = `${route.start.lat.toFixed(5)},${route.start.lon.toFixed(5)}`;
  const destination = `${route.end.lat.toFixed(5)},${route.end.lon.toFixed(5)}`;
  const waypoints = sampleIntermediateWaypoints(route.coordinates, 7)
    .map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`)
    .join("|");

  const params = new URLSearchParams({
    api: "1",
    origin,
    destination,
    travelmode: "walking",
  });
  if (waypoints) params.set("waypoints", waypoints);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function buildAppleMapsWalkingUrl(route: RunRoute): string {
  const saddr = `${route.start.lat.toFixed(5)},${route.start.lon.toFixed(5)}`;
  const waypoints = sampleIntermediateWaypoints(route.coordinates, 3);
  const stops = [
    ...waypoints.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`),
    `${route.end.lat.toFixed(5)},${route.end.lon.toFixed(5)}`,
  ];
  const daddr = stops.join("+to:");
  return `https://maps.apple.com/?saddr=${encodeURIComponent(saddr)}&daddr=${daddr}&dirflg=w`;
}
