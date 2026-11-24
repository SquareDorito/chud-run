import { NextRequest, NextResponse } from "next/server";
import {
  bearingDegrees,
  destinationPoint,
  fetchRouteElevationStats,
  findNearbyPOIs,
  haversineMeters,
  metersToMiles,
  milesToMeters,
} from "@/lib/geo";
import type {
  LatLng,
  PlaceSuggestion,
  RouteSearchRequest,
  RunRoute,
  ScenicPOI,
  SurfaceBreakdown,
} from "@/lib/types";

const OSRM_FOOT_BASE = "https://routing.openstreetmap.de/routed-foot/route/v1/foot";
const OVERPASS_BASE = "https://overpass-api.de/api/interpreter";
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT = "ChudRun/1.0 (scenic running route planner)";

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

interface ParkGeometry {
  name: string;
  centroid: LatLng;
  points: LatLng[];
  spanMeters: number;
}

interface TrackGeometry {
  name: string;
  centroid: LatLng;
  points: LatLng[];
  perimeterMeters: number;
}

interface OSRMStep {
  distance: number;
  duration: number;
  name: string;
  ref?: string;
  mode: string;
}

interface OSRMRoute {
  distance: number;
  duration: number;
  geometry: {
    type: "LineString";
    coordinates: [number, number][]; // [lon, lat]
  };
  legs: {
    steps: OSRMStep[];
  }[];
}

const FOOD_KEYWORDS = [
  "coffee",
  "cafe",
  "espresso",
  "latte",
  "matcha",
  "tea",
  "taco",
  "tacos",
  "mexican",
  "pizza",
  "ramen",
  "sushi",
  "noodle",
  "burger",
  "burgers",
  "bagel",
  "bagels",
  "bakery",
  "pastry",
  "croissant",
  "donut",
  "donuts",
  "ice cream",
  "gelato",
  "boba",
  "smoothie",
  "juice",
  "acai",
  "sandwich",
  "deli",
  "brunch",
  "breakfast",
  "brewery",
  "beer",
  "bar",
  "pub",
  "thai",
  "indian",
  "italian",
  "korean",
  "pho",
  "dim sum",
  "dumpling",
  "food",
  "eat",
  "restaurant",
];

function isFoodOrVibeQuery(query: string): boolean {
  const q = query.toLowerCase();
  return FOOD_KEYWORDS.some((kw) => q.includes(kw));
}

function computePolygonPerimeter(points: LatLng[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1], points[i]);
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (haversineMeters(first, last) > 3) {
    total += haversineMeters(last, first);
  }
  return total;
}

function extractParkTraversePoints(
  park: ParkGeometry,
  fromPt: LatLng,
  toPt?: LatLng
): { entry: LatLng; interior: LatLng; exit: LatLng } {
  let entry = park.points[0];
  let bestEntryDist = Infinity;
  for (const pt of park.points) {
    const d = haversineMeters(fromPt, pt);
    if (d < bestEntryDist) {
      bestEntryDist = d;
      entry = pt;
    }
  }

  let exit = park.points[Math.floor(park.points.length / 2)];
  if (toPt) {
    let bestExitDist = Infinity;
    for (const pt of park.points) {
      const dToEnd = haversineMeters(toPt, pt);
      if (dToEnd < bestExitDist && haversineMeters(entry, pt) >= 60) {
        bestExitDist = dToEnd;
        exit = pt;
      }
    }
  } else {
    let maxDistFromEntry = -1;
    for (const pt of park.points) {
      const d = haversineMeters(entry, pt);
      if (d > maxDistFromEntry) {
        maxDistFromEntry = d;
        exit = pt;
      }
    }
  }

  // Pull interior point slightly toward the park centroid so OSRM routes inside the park paths
  const midLat = (entry.lat + exit.lat) / 2;
  const midLon = (entry.lon + exit.lon) / 2;
  const interior: LatLng = {
    lat: park.centroid.lat * 0.65 + midLat * 0.35,
    lon: park.centroid.lon * 0.65 + midLon * 0.35,
  };

  return { entry, interior, exit };
}

async function fetchScenicAndRoutingFeatures(
  center: LatLng,
  radiusMeters: number
): Promise<{
  pois: ScenicPOI[];
  parks: ParkGeometry[];
  tracks: TrackGeometry[];
}> {
  const r = Math.min(Math.max(Math.round(radiusMeters), 1800), 10000);
  const query = `
    [out:json][timeout:7];
    (
      node["leisure"~"park|nature_reserve|garden"](around:${r},${center.lat},${center.lon});
      way["leisure"~"park|nature_reserve|garden"](around:${r},${center.lat},${center.lon});
      way["leisure"="track"](around:${Math.min(r, 4500)},${center.lat},${center.lon});
      node["tourism"~"viewpoint|attraction"](around:${r},${center.lat},${center.lon});
      node["historic"~"monument|memorial"](around:${r},${center.lat},${center.lon});
      way["waterway"~"river|canal"](around:${r},${center.lat},${center.lon});
      way["natural"="water"](around:${r},${center.lat},${center.lon});
    );
    out center geom 55;
  `;

  try {
    const res = await fetch(OVERPASS_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(7000),
    });

    if (!res.ok) return { pois: [], parks: [], tracks: [] };
    const data = (await res.json()) as { elements?: OverpassElement[] };
    const pois: ScenicPOI[] = [];
    const parks: ParkGeometry[] = [];
    const tracks: TrackGeometry[] = [];
    const seen = new Set<string>();

    for (const el of data.elements || []) {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      const tags = el.tags || {};

      if (tags.leisure === "track" && el.geometry && el.geometry.length >= 6) {
        const sport = (tags.sport || "").toLowerCase();
        if (!sport || sport.includes("running") || sport.includes("athletics")) {
          const pts = el.geometry.map((g) => ({ lat: g.lat, lon: g.lon }));
          const perimeter = computePolygonPerimeter(pts);
          if (perimeter >= 220 && perimeter <= 1200) {
            const cLat =
              lat ?? pts.reduce((s, p) => s + p.lat, 0) / pts.length;
            const cLon =
              lon ?? pts.reduce((s, p) => s + p.lon, 0) / pts.length;
            tracks.push({
              name: tags.name || "Running Track",
              centroid: { lat: cLat, lon: cLon },
              points: pts,
              perimeterMeters: perimeter,
            });
          }
        }
      }

      const name = tags.name;
      if (!lat || !lon || !name) continue;

      if (
        tags.leisure &&
        ["park", "nature_reserve", "garden"].includes(tags.leisure) &&
        el.geometry &&
        el.geometry.length >= 4
      ) {
        const pts = el.geometry.map((g) => ({ lat: g.lat, lon: g.lon }));
        let maxSpan = 0;
        for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 8))) {
          maxSpan = Math.max(maxSpan, haversineMeters({ lat, lon }, pts[i]) * 2);
        }
        if (maxSpan >= 140) {
          parks.push({
            name,
            centroid: { lat, lon },
            points: pts,
            spanMeters: maxSpan,
          });
        }
      }

      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());

      let category: ScenicPOI["category"] = "park";
      if (tags.waterway || tags.natural === "water") category = "water";
      else if (tags.tourism === "viewpoint") category = "viewpoint";
      else if (tags.historic || tags.tourism === "attraction")
        category = "landmark";

      pois.push({ name, category, lat, lon });
    }
    return { pois, parks, tracks };
  } catch {
    return { pois: [], parks: [], tracks: [] };
  }
}

async function resolveEndPlace(
  start: LatLng,
  endQuery: string,
  targetMiles?: number | null
): Promise<PlaceSuggestion | null> {
  const idealMeters = targetMiles
    ? milesToMeters(targetMiles) * 0.85
    : 3200; // ~2 miles default for food/area runs
  const searchRadius = Math.min(Math.max(Math.round(idealMeters * 1.45), 2500), 14000);

  // 1. If it looks like a food/drink query, search Overpass amenities/shops first
  if (isFoodOrVibeQuery(endQuery)) {
    const clean = endQuery.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
    const firstWord = clean.split(/\s+/)[0] || clean;
    const overQuery = `
      [out:json][timeout:6];
      (
        node["amenity"~"cafe|restaurant|fast_food|bar|pub|biergarten|ice_cream"]["name"~"${firstWord}",i](around:${searchRadius},${start.lat},${start.lon});
        node["amenity"~"cafe|restaurant|fast_food|bar|pub|biergarten|ice_cream"]["cuisine"~"${firstWord}",i](around:${searchRadius},${start.lat},${start.lon});
        node["shop"~"bakery|coffee|pastry"]["name"~"${firstWord}",i](around:${searchRadius},${start.lat},${start.lon});
        node["amenity"="cafe"](around:${searchRadius},${start.lat},${start.lon});
      );
      out body 25;
    `;
    try {
      const res = await fetch(OVERPASS_BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: `data=${encodeURIComponent(overQuery)}`,
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = (await res.json()) as { elements?: OverpassElement[] };
        const candidates = (data.elements || [])
          .filter((el) => el.lat && el.lon && el.tags?.name)
          .map((el) => {
            const tags = el.tags!;
            const name = tags.name!;
            const matchesKeyword =
              name.toLowerCase().includes(firstWord) ||
              (tags.cuisine || "").toLowerCase().includes(firstWord) ||
              (tags.amenity || "").toLowerCase().includes(firstWord) ||
              (tags.shop || "").toLowerCase().includes(firstWord);
            const dist = haversineMeters(start, { lat: el.lat!, lon: el.lon! });
            const distPenalty = Math.abs(dist - idealMeters);
            return {
              name,
              lat: el.lat!,
              lon: el.lon!,
              type: tags.cuisine || tags.amenity || tags.shop || "food",
              score: (matchesKeyword ? 0 : 10000) + distPenalty,
            };
          })
          .sort((a, b) => a.score - b.score);

        if (candidates.length > 0 && candidates[0].score < 10000) {
          const best = candidates[0];
          return {
            label: `${best.name} (${endQuery})`,
            shortName: best.name,
            lat: best.lat,
            lon: best.lon,
            type: "food",
          };
        }
      }
    } catch {
      // fall through to Nominatim
    }
  }

  // 2. Bounded Nominatim search near start (handles addresses, neighborhoods, areas, or food names)
  try {
    const delta = 0.14; // ~15km box
    const viewbox = `${start.lon - delta},${start.lat + delta},${start.lon + delta},${start.lat - delta}`;
    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(endQuery)}&format=jsonv2&addressdetails=1&limit=5&viewbox=${viewbox}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(5500),
    });
    if (res.ok) {
      const items = (await res.json()) as {
        display_name: string;
        lat: string;
        lon: string;
        name?: string;
        type?: string;
      }[];
      if (items.length > 0) {
        // Prefer one closest to idealMeters if multiple
        const sorted = items
          .map((it) => ({
            it,
            dist: haversineMeters(start, {
              lat: parseFloat(it.lat),
              lon: parseFloat(it.lon),
            }),
          }))
          .sort(
            (a, b) =>
              Math.abs(a.dist - idealMeters) - Math.abs(b.dist - idealMeters)
          );
        const top = sorted[0].it;
        const shortName =
          top.name ||
          top.display_name
            .split(",")
            .slice(0, 2)
            .map((s) => s.trim())
            .join(", ");
        return {
          label: top.display_name,
          shortName,
          lat: parseFloat(top.lat),
          lon: parseFloat(top.lon),
          type: top.type,
        };
      }
    }
  } catch {
    // ignore
  }

  return null;
}

async function fetchOSRMFootRoute(
  waypoints: LatLng[]
): Promise<OSRMRoute | null> {
  const coordStr = waypoints.map((p) => `${p.lon},${p.lat}`).join(";");
  const url = `${OSRM_FOOT_BASE}/${coordStr}?overview=full&geometries=geojson&steps=true`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(7500),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code?: string;
      routes?: OSRMRoute[];
    };
    if (data.code !== "Ok" || !data.routes?.length) return null;
    return data.routes[0];
  } catch {
    return null;
  }
}

interface LightingSignals {
  litPoints: LatLng[];
  unlitPoints: LatLng[];
}

async function fetchLightingSignals(
  center: LatLng,
  radiusMeters: number
): Promise<LightingSignals> {
  const r = Math.min(Math.max(Math.round(radiusMeters), 1500), 7000);
  const query = `
    [out:json][timeout:6];
    (
      node["highway"="street_lamp"](around:${r},${center.lat},${center.lon});
      way["lit"="yes"](around:${r},${center.lat},${center.lon});
      way["lit"="no"](around:${r},${center.lat},${center.lon});
    );
    out center 120;
  `;

  try {
    const res = await fetch(OVERPASS_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(5500),
    });
    if (!res.ok) return { litPoints: [], unlitPoints: [] };
    const data = (await res.json()) as { elements?: OverpassElement[] };
    const litPoints: LatLng[] = [];
    const unlitPoints: LatLng[] = [];

    for (const el of data.elements || []) {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!lat || !lon) continue;
      if (el.tags?.lit === "no") {
        unlitPoints.push({ lat, lon });
      } else {
        litPoints.push({ lat, lon });
      }
    }
    return { litPoints, unlitPoints };
  } catch {
    return { litPoints: [], unlitPoints: [] };
  }
}

function computeNightLightingScore(
  coords: [number, number][],
  surfaceBreakdown: SurfaceBreakdown,
  lighting: LightingSignals
): { nightScore: number; nightLabel: "Well Lit" | "Moderate Light" | "Low Light" } {
  // Baseline from surface type: streets/sidewalks usually have street lighting;
  // unmapped trails/parks can be darker unless lit=yes or street lamps are present
  const streetAndRoadPct =
    surfaceBreakdown.quietStreetPct + surfaceBreakdown.mainRoadPct;
  let score = 46 + Math.round(streetAndRoadPct * 0.32);

  if (coords.length >= 2 && (lighting.litPoints.length > 0 || lighting.unlitPoints.length > 0)) {
    const sampleCount = Math.min(24, coords.length);
    const step = (coords.length - 1) / (sampleCount - 1);
    let nearLit = 0;
    let nearUnlit = 0;

    for (let i = 0; i < sampleCount; i++) {
      const idx = Math.min(coords.length - 1, Math.round(i * step));
      const pt = { lat: coords[idx][0], lon: coords[idx][1] };
      if (lighting.litPoints.some((lp) => haversineMeters(pt, lp) <= 140)) {
        nearLit++;
      }
      if (lighting.unlitPoints.some((up) => haversineMeters(pt, up) <= 120)) {
        nearUnlit++;
      }
    }

    const litRatio = nearLit / sampleCount;
    const unlitRatio = nearUnlit / sampleCount;
    score = Math.round(score + litRatio * 34 - unlitRatio * 38);
  }

  const nightScore = Math.min(98, Math.max(20, score));
  const nightLabel: "Well Lit" | "Moderate Light" | "Low Light" =
    nightScore >= 72
      ? "Well Lit"
      : nightScore >= 50
      ? "Moderate Light"
      : "Low Light";

  return { nightScore, nightLabel };
}

function computeUniquePathPct(coords: [number, number][]): number {
  if (coords.length < 10) return 100;
  // Sample ~45 evenly spaced points along the route
  const n = Math.min(45, coords.length);
  const pts: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(coords.length - 1, Math.round((i * (coords.length - 1)) / (n - 1)));
    pts.push({ lat: coords[idx][0], lon: coords[idx][1] });
  }

  // Skip the first/last ~12% near the start/finish where loops naturally converge
  const margin = Math.max(2, Math.floor(n * 0.12));
  let repeated = 0;
  let checked = 0;

  for (let i = margin; i < n - margin; i++) {
    checked++;
    for (let j = margin; j < i - 3; j++) {
      if (haversineMeters(pts[i], pts[j]) < 40) {
        repeated++;
        break;
      }
    }
  }

  if (checked === 0) return 100;
  return Math.max(10, Math.round(100 - (repeated / checked) * 100));
}

function analyzeRouteSurfaceAndScenery(
  osrmRoute: OSRMRoute,
  coords: [number, number][],
  allPois: ScenicPOI[]
): {
  trafficFreePct: number;
  sceneryScore: number;
  uniquePathPct: number;
  surfaceBreakdown: SurfaceBreakdown;
  highlights: string[];
  nearbyPois: ScenicPOI[];
} {
  let carFreeDist = 0;
  let quietDist = 0;
  let mainRoadDist = 0;

  const carFreeRegex =
    /(path|trail|greenway|promenade|esplanade|walkway|footpath|footway|boardwalk|towpath|cycleway|bikeway|pedestrian|riverwalk|bridle|running track|park loop)/i;
  const mainRoadRegex =
    /(ave|avenue|blvd|boulevard|hwy|highway|pkwy|parkway|expressway|turnpike|route\s+\d|us-\d|state route|broadway|causeway)/i;

  for (const leg of osrmRoute.legs || []) {
    for (const step of leg.steps || []) {
      const d = step.distance || 0;
      const name = (step.name || "").trim();
      const ref = (step.ref || "").trim();

      if (carFreeRegex.test(name) || step.mode === "pushing bike") {
        carFreeDist += d;
      } else if (ref || mainRoadRegex.test(name)) {
        mainRoadDist += d;
      } else {
        // Named local streets (St, Rd, Ln, Dr) and unnamed sidewalk/crosswalk connectors
        quietDist += d;
      }
    }
  }

  const total = carFreeDist + quietDist + mainRoadDist || 1;
  const nearbyPois = findNearbyPOIs(coords, allPois, 240);

  const carFreePct = Math.min(100, Math.round((carFreeDist / total) * 100));
  const mainRoadPct = Math.min(
    100 - carFreePct,
    Math.round((mainRoadDist / total) * 100)
  );
  const quietStreetPct = Math.max(0, 100 - carFreePct - mainRoadPct);

  // Overall low-traffic score: full credit for car-free paths, partial credit for quiet streets/sidewalks
  const trafficFreePct = Math.min(
    99,
    Math.max(15, carFreePct + Math.round(quietStreetPct * 0.65))
  );

  const uniquePathPct = computeUniquePathPct(coords);

  const sceneryRaw =
    48 +
    Math.min(30, nearbyPois.length * 7) +
    Math.min(20, Math.round(carFreePct * 0.25));
  const sceneryScore = Math.min(99, Math.max(45, sceneryRaw));

  const highlights = nearbyPois.slice(0, 4).map((p) => p.name);
  if (highlights.length === 0) {
    highlights.push(
      carFreePct >= 45
        ? "Dedicated Trails & Paths"
        : quietStreetPct >= 60
        ? "Quiet Streets & Sidewalks"
        : "Urban Corridor"
    );
  }

  return {
    trafficFreePct,
    sceneryScore,
    uniquePathPct,
    surfaceBreakdown: {
      carFreePct,
      quietStreetPct,
      mainRoadPct,
    },
    highlights,
    nearbyPois,
  };
}

function scaleWaypointFromStart(
  start: LatLng,
  wp: LatLng,
  scaleFactor: number
): LatLng {
  const dist = haversineMeters(start, wp);
  const brg = bearingDegrees(start, wp);
  return destinationPoint(start, dist * scaleFactor, brg);
}

async function buildTrackLapRoute(
  start: PlaceSuggestion,
  track: TrackGeometry,
  targetMeters: number,
  scenicPois: ScenicPOI[],
  lightingSignals: LightingSignals
): Promise<RunRoute | null> {
  // Find closest vertex on track to start
  let entryIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < track.points.length; i++) {
    const d = haversineMeters(start, track.points[i]);
    if (d < bestDist) {
      bestDist = d;
      entryIdx = i;
    }
  }
  if (bestDist > Math.max(targetMeters * 0.4, 2200)) return null;

  const entryPt = track.points[entryIdx];
  const approach = await fetchOSRMFootRoute([start, entryPt]);
  if (!approach) return null;

  const remainingMeters = targetMeters - approach.distance * 2;
  if (remainingMeters < track.perimeterMeters * 0.8) return null;

  const laps = Math.max(
    1,
    Math.min(25, Math.round(remainingMeters / track.perimeterMeters))
  );
  const totalMeters = approach.distance * 2 + laps * track.perimeterMeters;
  const distMiles = metersToMiles(totalMeters);

  // Rotate track loop to start/end at entryIdx
  const orderedLoop: [number, number][] = [];
  for (let i = 0; i < track.points.length; i++) {
    const pt = track.points[(entryIdx + i) % track.points.length];
    orderedLoop.push([pt.lat, pt.lon]);
  }
  orderedLoop.push([entryPt.lat, entryPt.lon]);

  const approachCoords: [number, number][] = approach.geometry.coordinates.map(
    ([lon, lat]) => [lat, lon]
  );
  const returnCoords = [...approachCoords].reverse();

  // For the map polyline, include up to 2 visual lap passes so geometry stays crisp & compact
  const visualLaps = Math.min(laps, 2);
  const coords: [number, number][] = [...approachCoords];
  for (let l = 0; l < visualLaps; l++) {
    coords.push(...orderedLoop);
  }
  coords.push(...returnCoords);

  const approachAnalysis = analyzeRouteSurfaceAndScenery(
    approach,
    approachCoords,
    scenicPois
  );
  const lapMeters = laps * track.perimeterMeters;
  const approachMeters = approach.distance * 2;
  const totalCarFreeMeters =
    (approachAnalysis.surfaceBreakdown.carFreePct / 100) * approachMeters +
    lapMeters;
  const totalQuietMeters =
    (approachAnalysis.surfaceBreakdown.quietStreetPct / 100) * approachMeters;

  const carFreePct = Math.min(
    100,
    Math.round((totalCarFreeMeters / totalMeters) * 100)
  );
  const quietStreetPct = Math.min(
    100 - carFreePct,
    Math.round((totalQuietMeters / totalMeters) * 100)
  );
  const mainRoadPct = Math.max(0, 100 - carFreePct - quietStreetPct);
  const trafficFreePct = Math.min(
    99,
    Math.max(15, carFreePct + Math.round(quietStreetPct * 0.65))
  );

  const surfaceBreakdown: SurfaceBreakdown = {
    carFreePct,
    quietStreetPct,
    mainRoadPct,
  };
  const night = computeNightLightingScore(
    coords,
    surfaceBreakdown,
    lightingSignals
  );
  const nearbyPois = findNearbyPOIs(coords, scenicPois, 260);
  const sceneryScore = Math.min(
    99,
    Math.max(55, 58 + Math.min(24, nearbyPois.length * 6) + Math.round(carFreePct * 0.18))
  );

  return {
    id: `track-${Math.round(totalMeters)}-${laps}`,
    name: `${track.name} (${laps} ${laps === 1 ? "Lap" : "Laps"})`,
    tagline: `Traffic-free track workout · ${laps} ${laps === 1 ? "lap" : "laps"} around ${track.name}`,
    mode: "loop",
    distanceMiles: Math.round(distMiles * 100) / 100,
    estimatedMinutes: Math.max(5, Math.round(distMiles * 9.0)),
    trafficFreePct,
    sceneryScore,
    nightScore: night.nightScore,
    nightLabel: night.nightLabel,
    lapInfo: {
      laps,
      featureName: track.name,
      kind: "track",
    },
    surfaceBreakdown,
    highlights: [
      track.name,
      `${laps} Track ${laps === 1 ? "Lap" : "Laps"}`,
      ...nearbyPois.slice(0, 2).map((p) => p.name),
    ],
    start,
    end: start,
    coordinates: coords,
    pois: [
      {
        name: track.name,
        category: "park",
        lat: track.centroid.lat,
        lon: track.centroid.lon,
      },
      ...nearbyPois.slice(0, 5),
    ],
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as RouteSearchRequest;
    const {
      start,
      minMiles,
      maxMiles,
      endQuery,
      endPlace,
      preferLoop = true,
    } = body;

    if (!start || typeof start.lat !== "number" || typeof start.lon !== "number") {
      return NextResponse.json(
        { error: "Start location is required." },
        { status: 400 }
      );
    }

    const hasRange =
      typeof minMiles === "number" &&
      typeof maxMiles === "number" &&
      maxMiles >= minMiles;
    const desiredMiles = hasRange
      ? Math.min((minMiles + maxMiles) / 2, 30)
      : null;

    // Resolve end destination if user typed a food/area/address
    let resolvedEnd: PlaceSuggestion | null = endPlace || null;
    if (!resolvedEnd && endQuery && endQuery.trim().length > 0) {
      resolvedEnd = await resolveEndPlace(start, endQuery.trim(), desiredMiles);
    }

    const effectiveMiles = desiredMiles ?? (resolvedEnd ? 2.5 : 3.5);
    const searchRadius = milesToMeters(effectiveMiles) * 0.75;
    const [{ pois: scenicPois, parks, tracks }, lightingSignals] =
      await Promise.all([
        fetchScenicAndRoutingFeatures(start, searchRadius),
        fetchLightingSignals(start, searchRadius),
      ]);

    const routes: RunRoute[] = [];

    if (resolvedEnd) {
      // --- POINT-TO-POINT MODE ---
      const directDist = haversineMeters(start, resolvedEnd);
      const midPoint: LatLng = {
        lat: (start.lat + resolvedEnd.lat) / 2,
        lon: (start.lon + resolvedEnd.lon) / 2,
      };
      const corridorParks = parks
        .filter(
          (p) =>
            haversineMeters(midPoint, p.centroid) <
              Math.max(directDist * 0.85, 2200) &&
            haversineMeters(start, p.centroid) > 150 &&
            haversineMeters(resolvedEnd!, p.centroid) > 150
        )
        .slice(0, 3);

      const corridorPois = scenicPois
        .filter(
          (p) =>
            haversineMeters(midPoint, p) < Math.max(directDist * 0.85, 2000) &&
            haversineMeters(start, p) > 250 &&
            haversineMeters(resolvedEnd!, p) > 250
        )
        .slice(0, 6);

      const candidateWaypoints: {
        name: string;
        tagline: string;
        points: LatLng[];
      }[] = [
        {
          name: `Scenic Path to ${resolvedEnd.shortName}`,
          tagline: "Low-traffic pedestrian & park-friendly route",
          points: [start, resolvedEnd],
        },
      ];

      // Park-Interior Chaining: route through entry -> interior -> exit of corridor parks
      for (const park of corridorParks) {
        const { entry, interior, exit } = extractParkTraversePoints(
          park,
          start,
          resolvedEnd
        );
        candidateWaypoints.push({
          name: `Through ${park.name}`,
          tagline: `Routes through the interior trails of ${park.name} to ${resolvedEnd.shortName}`,
          points: [start, entry, interior, exit, resolvedEnd],
        });
      }

      if (corridorPois[0]) {
        candidateWaypoints.push({
          name: `Via ${corridorPois[0].name}`,
          tagline: `Detours through ${corridorPois[0].name} for extra greenery`,
          points: [start, corridorPois[0], resolvedEnd],
        });
      }
      if (corridorPois[1]) {
        candidateWaypoints.push({
          name: `${corridorPois[1].name} Greenway`,
          tagline: `Scenic nature & landmark corridor to ${resolvedEnd.shortName}`,
          points: [start, corridorPois[1], resolvedEnd],
        });
      }

      // Ensure up to 9 distinct route options even when Overpass has fewer corridor POIs
      if (candidateWaypoints.length < 9) {
        const brg = bearingDegrees(start, resolvedEnd);
        const sideDist =
          desiredMiles && milesToMeters(desiredMiles) > directDist * 1.25
            ? Math.min((milesToMeters(desiredMiles) - directDist) * 0.45, 3500)
            : Math.min(Math.max(directDist * 0.25, 350), 1400);

        const arcs = [
          { angle: 85, mult: 1.0, name: "Quiet Parkside Detour", tagline: `Alternative low-traffic path to ${resolvedEnd.shortName}` },
          { angle: 275, mult: 1.0, name: "Alternate Scenic Corridor", tagline: `Secondary quiet-street route to ${resolvedEnd.shortName}` },
          { angle: 55, mult: 1.35, name: "Extended Greenway Loop-In", tagline: `Longer low-traffic approach to ${resolvedEnd.shortName}` },
          { angle: 305, mult: 1.35, name: "Wide Neighborhood Path", tagline: `Calm residential & trail route to ${resolvedEnd.shortName}` },
          { angle: 110, mult: 0.75, name: "Inner Side-Street Path", tagline: `Direct quiet-street alternative to ${resolvedEnd.shortName}` },
          { angle: 250, mult: 0.75, name: "Westside Trail Connector", tagline: `Low-traffic connector to ${resolvedEnd.shortName}` },
          { angle: 40, mult: 1.6, name: "Outer Scenic Arc", tagline: `Longer scenic run to ${resolvedEnd.shortName}` },
          { angle: 320, mult: 1.6, name: "Parkway Bypass Route", tagline: `Avoids main roads on the way to ${resolvedEnd.shortName}` },
        ];

        for (const arc of arcs) {
          if (candidateWaypoints.length >= 9) break;
          const wp = destinationPoint(midPoint, sideDist * arc.mult, (brg + arc.angle) % 360);
          candidateWaypoints.push({
            name: arc.name,
            tagline: arc.tagline,
            points: [start, wp, resolvedEnd],
          });
        }
      }

      const osrmResults = await Promise.all(
        candidateWaypoints.map((c) => fetchOSRMFootRoute(c.points))
      );

      osrmResults.forEach((osrm, idx) => {
        if (!osrm) return;
        const coords: [number, number][] = osrm.geometry.coordinates.map(
          ([lon, lat]) => [lat, lon]
        );
        const distMiles = metersToMiles(osrm.distance);
        const analysis = analyzeRouteSurfaceAndScenery(osrm, coords, scenicPois);
        const night = computeNightLightingScore(
          coords,
          analysis.surfaceBreakdown,
          lightingSignals
        );
        const estMinutes = Math.max(5, Math.round(distMiles * 9.0));

        routes.push({
          id: `p2p-${idx}-${Math.round(osrm.distance)}`,
          name: candidateWaypoints[idx].name,
          tagline: candidateWaypoints[idx].tagline,
          mode: "point-to-point",
          distanceMiles: Math.round(distMiles * 100) / 100,
          estimatedMinutes: estMinutes,
          trafficFreePct: analysis.trafficFreePct,
          sceneryScore: analysis.sceneryScore,
          nightScore: night.nightScore,
          nightLabel: night.nightLabel,
          uniquePathPct: preferLoop ? analysis.uniquePathPct : undefined,
          surfaceBreakdown: analysis.surfaceBreakdown,
          highlights: analysis.highlights,
          start,
          end: resolvedEnd!,
          destinationFoodOrArea: endQuery || resolvedEnd!.shortName,
          coordinates: coords,
          pois: [
            ...analysis.nearbyPois.slice(0, 6),
            {
              name: resolvedEnd!.shortName,
              category: resolvedEnd!.type === "food" ? "food" : "landmark",
              lat: resolvedEnd!.lat,
              lon: resolvedEnd!.lon,
            },
          ],
        });
      });
    } else {
      // --- LOOP MODE (only Start required!) ---
      const targetMeters = milesToMeters(effectiveMiles);
      // Heuristic: a 2-waypoint triangle with radius ~0.27 * targetMeters yields ~targetMeters via street grid
      const radiusM = targetMeters * 0.27;

      interface LoopTemplate {
        name: string;
        tagline: string;
        waypoints: LatLng[];
        scalable: boolean;
      }

      const loopTemplates: LoopTemplate[] = [];

      // 1. Park-Interior Chaining loops (route INTO park interior trails, not just park edges)
      const nearbyParks = parks
        .map((park) => ({
          park,
          dist: haversineMeters(start, park.centroid),
        }))
        .filter(
          (x) =>
            x.dist >= Math.max(120, radiusM * 0.25) &&
            x.dist <= Math.max(radiusM * 1.6, 2500)
        )
        .sort((a, b) => a.dist - b.dist);

      for (const { park } of nearbyParks.slice(0, 2)) {
        const { entry, interior, exit } = extractParkTraversePoints(park, start);
        loopTemplates.push({
          name: `${park.name} Interior Loop`,
          tagline: `Chains through interior trails of ${park.name} & quiet connectors`,
          waypoints: preferLoop
            ? [start, entry, interior, exit, start]
            : [start, interior, start],
          scalable: false,
        });
      }

      // 2. Scenic POI loops
      const idealPois = scenicPois
        .map((p) => ({
          poi: p,
          dist: haversineMeters(start, p),
          brg: bearingDegrees(start, p),
        }))
        .filter((x) => x.dist >= radiusM * 0.45 && x.dist <= radiusM * 1.65);

      if (idealPois.length >= 2) {
        const p1 = idealPois[0];
        const p2 =
          idealPois.find(
            (x) => Math.abs(((x.brg - p1.brg + 540) % 360) - 180) > 45
          ) || destinationPoint(start, radiusM, (p1.brg + 72) % 360);
        const wp2 = "poi" in p2 ? p2.poi : p2;
        loopTemplates.push({
          name: `${p1.poi.name} Scenic Loop`,
          tagline: `Prioritizes parks, greenery & traffic-free paths`,
          waypoints: preferLoop
            ? [start, p1.poi, wp2, start]
            : [start, p1.poi, start],
          scalable: true,
        });
      }

      // 3. Directional sector loops
      const bearings = [
        { b1: 15, b2: 88, name: "Park & Waterfront Loop", tagline: "Low-traffic paths & open scenery" },
        { b1: 135, b2: 208, name: "Quiet Greenway Loop", tagline: "Tree-lined streets & neighborhood trails" },
        { b1: 255, b2: 328, name: "Landmark & Vista Loop", tagline: "Scenic loop with minimal road crossings" },
        { b1: 60, b2: 145, name: "Morning Shade Loop", tagline: "Quiet side-street & park connector" },
        { b1: 195, b2: 280, name: "Neighborhood Trail Loop", tagline: "Relaxed traffic-free local loop" },
        { b1: 35, b2: 115, name: "Eastside Scenic Loop", tagline: "Calm residential streets & park edges" },
        { b1: 165, b2: 245, name: "Southside Park Loop", tagline: "Low-traffic loop away from arterials" },
        { b1: 285, b2: 5, name: "Northside Vista Loop", tagline: "Scenic loop with quiet connectors" },
        { b1: 100, b2: 185, name: "Crosstown Quiet Loop", tagline: "Balanced neighborhood & path route" },
      ];

      for (const b of bearings) {
        if (loopTemplates.length >= 9) break;
        const wp1 = destinationPoint(start, radiusM, b.b1);
        const wp2 = destinationPoint(start, radiusM, b.b2);
        loopTemplates.push({
          name: b.name,
          tagline: b.tagline,
          waypoints: preferLoop
            ? [start, wp1, wp2, start]
            : [
                start,
                destinationPoint(start, targetMeters * 0.44, b.b1),
                start,
              ],
          scalable: true,
        });
      }

      // Pass 1: Fetch OSRM loops + Track-lap route (if a running track is nearby) in parallel
      const trackPromise =
        tracks.length > 0
          ? buildTrackLapRoute(
              start,
              tracks[0],
              targetMeters,
              scenicPois,
              lightingSignals
            )
          : Promise.resolve(null);

      const [pass1Results, trackRoute] = await Promise.all([
        Promise.all(loopTemplates.map((t) => fetchOSRMFootRoute(t.waypoints))),
        trackPromise,
      ]);

      if (trackRoute) {
        routes.push(trackRoute);
      }

      // Pass 2: Two-Pass Distance Calibration for off-target scalable loops
      const minTargetM =
        hasRange && minMiles != null
          ? milesToMeters(minMiles)
          : targetMeters * 0.88;
      const maxTargetM =
        hasRange && maxMiles != null
          ? milesToMeters(maxMiles)
          : targetMeters * 1.12;

      const recalibrationTasks: {
        idx: number;
        promise: Promise<OSRMRoute | null>;
      }[] = [];

      pass1Results.forEach((osrm, idx) => {
        if (!osrm || !loopTemplates[idx].scalable) return;
        if (recalibrationTasks.length >= 4) return;
        const outOfRange =
          osrm.distance < minTargetM || osrm.distance > maxTargetM;
        if (!outOfRange || osrm.distance < 200) return;

        const scale = Math.min(1.85, Math.max(0.55, targetMeters / osrm.distance));
        const scaledWaypoints = loopTemplates[idx].waypoints.map((wp, wIdx) =>
          wIdx === 0 || wIdx === loopTemplates[idx].waypoints.length - 1
            ? wp
            : scaleWaypointFromStart(start, wp, scale)
        );
        recalibrationTasks.push({
          idx,
          promise: fetchOSRMFootRoute(scaledWaypoints),
        });
      });

      const pass2Settled = await Promise.all(
        recalibrationTasks.map(async (task) => ({
          idx: task.idx,
          osrm: await task.promise,
        }))
      );

      const finalOsrmResults = [...pass1Results];
      for (const { idx, osrm } of pass2Settled) {
        if (!osrm) continue;
        const prev = finalOsrmResults[idx];
        if (
          !prev ||
          Math.abs(osrm.distance - targetMeters) <
            Math.abs(prev.distance - targetMeters)
        ) {
          finalOsrmResults[idx] = osrm;
        }
      }

      finalOsrmResults.forEach((osrm, idx) => {
        if (!osrm) return;
        const coords: [number, number][] = osrm.geometry.coordinates.map(
          ([lon, lat]) => [lat, lon]
        );
        const distMiles = metersToMiles(osrm.distance);
        const analysis = analyzeRouteSurfaceAndScenery(osrm, coords, scenicPois);
        const night = computeNightLightingScore(
          coords,
          analysis.surfaceBreakdown,
          lightingSignals
        );
        const estMinutes = Math.max(5, Math.round(distMiles * 9.0));

        routes.push({
          id: `loop-${idx}-${Math.round(osrm.distance)}`,
          name: loopTemplates[idx].name,
          tagline: loopTemplates[idx].tagline,
          mode: "loop",
          distanceMiles: Math.round(distMiles * 100) / 100,
          estimatedMinutes: estMinutes,
          trafficFreePct: analysis.trafficFreePct,
          sceneryScore: analysis.sceneryScore,
          nightScore: night.nightScore,
          nightLabel: night.nightLabel,
          uniquePathPct: preferLoop ? analysis.uniquePathPct : undefined,
          surfaceBreakdown: analysis.surfaceBreakdown,
          highlights: analysis.highlights,
          start,
          end: start,
          coordinates: coords,
          pois: analysis.nearbyPois.slice(0, 6),
        });
      });
    }

    // Cost-weighted multi-objective ranking:
    // prioritizes car-free & low-traffic paths, scenery, unique roads (for loops),
    // night lighting tie-breaker, and tight distance-range fit.
    const midMiles =
      hasRange && minMiles != null && maxMiles != null
        ? (minMiles + maxMiles) / 2
        : effectiveMiles;

    const scoreRoute = (r: RunRoute) => {
      let rangePenalty = 0;
      if (hasRange && minMiles != null && maxMiles != null) {
        if (r.distanceMiles < minMiles) {
          rangePenalty = (minMiles - r.distanceMiles) * 18;
        } else if (r.distanceMiles > maxMiles) {
          rangePenalty = (r.distanceMiles - maxMiles) * 18;
        } else {
          rangePenalty = Math.abs(r.distanceMiles - midMiles) * 1.5;
        }
      }
      const repeatBonus =
        preferLoop && !r.lapInfo ? (r.uniquePathPct ?? 100) * 0.32 : 0;
      const nightTieBreaker = (r.nightScore ?? 60) * 0.08;
      const trackMatchBonus = r.lapInfo && rangePenalty === 0 ? 6 : 0;

      return (
        r.trafficFreePct * 0.48 +
        r.sceneryScore * 0.34 +
        repeatBonus +
        nightTieBreaker +
        trackMatchBonus -
        rangePenalty
      );
    };

    routes.sort((a, b) => scoreRoute(b) - scoreRoute(a));

    // Deduplicate near-identical routes and cap to top 9 (UI shows 3 at a time)
    const uniqueRoutes: RunRoute[] = [];
    for (const r of routes) {
      const isDup = uniqueRoutes.some(
        (u) =>
          Math.abs(u.distanceMiles - r.distanceMiles) < 0.05 &&
          u.trafficFreePct === r.trafficFreePct &&
          u.sceneryScore === r.sceneryScore
      );
      if (!isDup) uniqueRoutes.push(r);
      if (uniqueRoutes.length >= 9) break;
    }

    // Fetch real elevation stats in parallel for the top 1-5 routes
    await Promise.all(
      uniqueRoutes.map(async (r) => {
        const elev = await fetchRouteElevationStats(
          r.coordinates,
          r.distanceMiles
        );
        if (elev) {
          r.elevationGainFt = elev.elevationGainFt;
          r.terrainLabel = elev.terrainLabel;
        }
      })
    );

    return NextResponse.json({
      routes: uniqueRoutes,
      resolvedEnd,
      note:
        endQuery && !resolvedEnd
          ? `Couldn't find an exact match for "${endQuery}" nearby — showing scenic loops from your start instead.`
          : undefined,
    });
  } catch (err) {
    console.error("Route generation error:", err);
    return NextResponse.json(
      { error: "Unable to generate routes right now. Please try again." },
      { status: 500 }
    );
  }
}
