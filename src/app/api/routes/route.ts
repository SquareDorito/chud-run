import { NextRequest, NextResponse } from "next/server";
import {
  bearingDegrees,
  computePolylineOverlap,
  countNearbyPoints,
  decodePolyline6,
  destinationPoint,
  fetchRouteElevationStats,
  findNearbyPOIs,
  haversineMeters,
  metersToMiles,
  milesToMeters,
} from "@/lib/geo";
import type {
  ElevationPreference,
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

const DIRECTION_PREFIX_BEARINGS: Record<string, number> = {
  north: 0,
  northern: 0,
  upper: 0,
  east: 90,
  eastern: 90,
  south: 180,
  southern: 180,
  lower: 180,
  west: 270,
  western: 270,
};

const AREA_CATEGORIES = new Set(["place", "boundary"]);
const AREA_TYPES = new Set([
  "neighbourhood",
  "neighborhood",
  "suburb",
  "quarter",
  "city_district",
  "borough",
  "village",
  "town",
  "city",
  "administrative",
  "park",
  "pier",
]);
const NOISE_POI_TYPES = new Set([
  "school",
  "kindergarten",
  "dentist",
  "clinic",
  "hospital",
  "doctors",
  "office",
  "company",
  "pharmacy",
  "parking",
]);

const FOOD_SYNONYMS: Record<string, string[]> = {
  pizza: ["pizza", "pizzeria", "italian"],
  taco: ["taco", "taqueria", "mexican"],
  tacos: ["taco", "taqueria", "mexican"],
  coffee: ["coffee", "cafe", "espresso", "roast"],
  cafe: ["cafe", "coffee", "espresso"],
  burger: ["burger", "american"],
  burgers: ["burger", "american"],
  ramen: ["ramen", "japanese", "noodle"],
  sushi: ["sushi", "japanese"],
  bagel: ["bagel", "bakery", "deli"],
  bagels: ["bagel", "bakery", "deli"],
  bakery: ["bakery", "pastry", "patisserie", "croissant"],
  donut: ["donut", "doughnut", "bakery"],
  donuts: ["donut", "doughnut", "bakery"],
  "ice cream": ["ice_cream", "ice cream", "gelato"],
  gelato: ["gelato", "ice_cream", "ice cream"],
  boba: ["boba", "bubble_tea", "tea"],
  sandwich: ["sandwich", "deli", "sub"],
  brunch: ["brunch", "breakfast", "cafe", "diner"],
  breakfast: ["breakfast", "brunch", "cafe", "bakery", "diner"],
  brewery: ["brewery", "biergarten", "pub", "bar"],
};

function expandFoodTerms(query: string): string[] {
  const clean = query.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  if (!clean) return [];
  const words = clean.split(/\s+/).filter((w) => w.length >= 2);
  const terms = new Set<string>(words);
  if (FOOD_SYNONYMS[clean]) {
    for (const s of FOOD_SYNONYMS[clean]) terms.add(s);
  }
  for (const w of words) {
    if (FOOD_SYNONYMS[w]) {
      for (const s of FOOD_SYNONYMS[w]) terms.add(s);
    }
    // Simple singularization for plural queries (e.g. "pizzerias" -> "pizzeria")
    if (w.endsWith("s") && w.length > 3) terms.add(w.slice(0, -1));
  }
  return Array.from(terms);
}

interface CachedGooglePlace {
  name: string;
  address: string;
  lat: number;
  lon: number;
  rating?: number;
  ratingCount?: number;
}

const GOOGLE_PLACES_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const GOOGLE_PLACES_CACHE_MAX = 500;
const GOOGLE_PLACES_WINDOW_MS = 60 * 1000; // 1 minute
const GOOGLE_PLACES_MAX_PER_IP = 3;
const GOOGLE_PLACES_MAX_GLOBAL = 10;

const googlePlacesCache = new Map<
  string,
  { expiresAt: number; places: CachedGooglePlace[] }
>();
const googlePlacesIpHits = new Map<string, number[]>();
let googlePlacesGlobalHits: number[] = [];

function allowGooglePlacesCall(clientIp: string): boolean {
  const now = Date.now();
  const cutoff = now - GOOGLE_PLACES_WINDOW_MS;

  googlePlacesGlobalHits = googlePlacesGlobalHits.filter((t) => t > cutoff);
  if (googlePlacesGlobalHits.length >= GOOGLE_PLACES_MAX_GLOBAL) {
    return false;
  }

  const key = clientIp || "unknown";
  const ipTimes = (googlePlacesIpHits.get(key) || []).filter((t) => t > cutoff);
  if (ipTimes.length >= GOOGLE_PLACES_MAX_PER_IP) {
    googlePlacesIpHits.set(key, ipTimes);
    return false;
  }

  ipTimes.push(now);
  googlePlacesIpHits.set(key, ipTimes);
  googlePlacesGlobalHits.push(now);

  // Prevent unbounded IP map growth
  if (googlePlacesIpHits.size > 500) {
    for (const [k, times] of googlePlacesIpHits) {
      if (times.every((t) => t <= cutoff)) googlePlacesIpHits.delete(k);
    }
  }
  return true;
}

async function resolveFoodViaGooglePlaces(
  start: LatLng,
  endQuery: string,
  idealMeters: number,
  searchRadius: number,
  maxResults = 4,
  clientIp = "unknown"
): Promise<PlaceSuggestion[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return [];

  const maxAllowedDist = Math.max(searchRadius * 2.2, 22000);
  const clampedRadius = Math.min(searchRadius, 15000);
  // ~1.1km grid cell + normalized query + 2km radius bucket
  const cacheKey = `${Math.round(start.lat * 100)},${Math.round(start.lon * 100)}|${endQuery.toLowerCase().trim()}|${Math.round(clampedRadius / 2000)}`;

  let rawPlaces: CachedGooglePlace[] | null = null;
  const cached = googlePlacesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    rawPlaces = cached.places;
  } else {
    if (cached) googlePlacesCache.delete(cacheKey);
    if (!allowGooglePlacesCall(clientIp)) {
      return [];
    }

    try {
      const res = await fetch(
        "https://places.googleapis.com/v1/places:searchText",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask":
              "places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.businessStatus",
          },
          body: JSON.stringify({
            textQuery: endQuery,
            maxResultCount: 12,
            locationBias: {
              circle: {
                center: { latitude: start.lat, longitude: start.lon },
                radius: clampedRadius,
              },
            },
          }),
          signal: AbortSignal.timeout(5500),
        }
      );

      if (!res.ok) return [];
      const data = (await res.json()) as {
        places?: {
          displayName?: { text?: string };
          formattedAddress?: string;
          location?: { latitude?: number; longitude?: number };
          rating?: number;
          userRatingCount?: number;
          businessStatus?: string;
        }[];
      };

      rawPlaces = (data.places || [])
        .filter(
          (p) =>
            p.displayName?.text &&
            p.location?.latitude != null &&
            p.location?.longitude != null &&
            p.businessStatus !== "CLOSED_PERMANENTLY"
        )
        .map((p) => ({
          name: p.displayName!.text!,
          address: p.formattedAddress || p.displayName!.text!,
          lat: p.location!.latitude!,
          lon: p.location!.longitude!,
          rating: p.rating,
          ratingCount: p.userRatingCount,
        }));

      if (googlePlacesCache.size >= GOOGLE_PLACES_CACHE_MAX) {
        const oldestKey = googlePlacesCache.keys().next().value;
        if (oldestKey) googlePlacesCache.delete(oldestKey);
      }
      googlePlacesCache.set(cacheKey, {
        expiresAt: Date.now() + GOOGLE_PLACES_CACHE_TTL_MS,
        places: rawPlaces,
      });
    } catch {
      return [];
    }
  }

  const candidates = rawPlaces
    .map((p) => {
      const dist = haversineMeters(start, { lat: p.lat, lon: p.lon });
      const rating = p.rating ?? 3.8;
      const count = p.ratingCount ?? 10;
      // Favor highly-rated, well-reviewed spots near idealMeters
      const qualityScore = rating * Math.log10(count + 10) * 320;
      const distPenalty = Math.abs(dist - idealMeters);
      const lowRatingPenalty = rating < 4.0 ? (4.0 - rating) * 1800 : 0;
      return {
        ...p,
        dist,
        score: qualityScore - distPenalty - lowRatingPenalty,
      };
    })
    .filter((c) => c.dist <= maxAllowedDist)
    .sort((a, b) => b.score - a.score);

  const results: PlaceSuggestion[] = [];
  for (const c of candidates) {
    const isDup = results.some(
      (r) =>
        r.shortName.toLowerCase() === c.name.toLowerCase() ||
        haversineMeters(r, c) < 80
    );
    if (isDup) continue;
    results.push({
      label:
        c.rating != null
          ? `${c.name} (★ ${c.rating.toFixed(1)}${c.ratingCount ? `, ${c.ratingCount}` : ""})`
          : `${c.name} (${endQuery})`,
      shortName: c.name,
      lat: c.lat,
      lon: c.lon,
      type: "food",
      rating: c.rating,
      ratingCount: c.ratingCount,
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

async function resolveEndPlaces(
  start: LatLng,
  endQuery: string,
  targetMiles?: number | null,
  maxFoodResults = 4,
  clientIp = "unknown"
): Promise<PlaceSuggestion[]> {
  const idealMeters = targetMiles
    ? milesToMeters(targetMiles) * 0.85
    : 3200; // ~2 miles default for food/area runs
  const searchRadius = Math.min(Math.max(Math.round(idealMeters * 1.45), 2500), 14000);
  const maxAllowedDist = Math.max(searchRadius * 2.5, 25000);
  const foodQuery = isFoodOrVibeQuery(endQuery);

  // 1a. If GOOGLE_PLACES_API_KEY is configured and this is a food query, rank top spots by live star ratings + reviews
  if (foodQuery && process.env.GOOGLE_PLACES_API_KEY) {
    const ratedSpots = await resolveFoodViaGooglePlaces(
      start,
      endQuery,
      idealMeters,
      searchRadius,
      maxFoodResults,
      clientIp
    );
    if (ratedSpots.length > 0) return ratedSpots;
  }

  // 1b. Keyless fuzzy food/drink search via Overpass (nodes + ways, synonym-expanded)
  if (foodQuery) {
    const terms = expandFoodTerms(endQuery);
    const regexPattern = terms.join("|");
    if (regexPattern) {
      const overQuery = `
        [out:json][timeout:7];
        (
          nwr["amenity"~"cafe|restaurant|fast_food|bar|pub|biergarten|ice_cream"]["name"~"${regexPattern}",i](around:${searchRadius},${start.lat},${start.lon});
          nwr["amenity"~"cafe|restaurant|fast_food|bar|pub|biergarten|ice_cream"]["cuisine"~"${regexPattern}",i](around:${searchRadius},${start.lat},${start.lon});
          nwr["shop"~"bakery|coffee|pastry|deli|ice_cream"]["name"~"${regexPattern}",i](around:${searchRadius},${start.lat},${start.lon});
        );
        out center 40;
      `;
      try {
        const res = await fetch(OVERPASS_BASE, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
          },
          body: `data=${encodeURIComponent(overQuery)}`,
          signal: AbortSignal.timeout(7000),
        });
        if (res.ok) {
          const data = (await res.json()) as { elements?: OverpassElement[] };
          const candidates = (data.elements || [])
            .map((el) => {
              const lat = el.lat ?? el.center?.lat;
              const lon = el.lon ?? el.center?.lon;
              const tags = el.tags || {};
              const name = tags.name;
              if (!lat || !lon || !name) return null;
              const hay = `${name} ${tags.cuisine || ""} ${tags.amenity || ""} ${tags.shop || ""}`.toLowerCase();
              const matchesKeyword = terms.some((t) => hay.includes(t));
              if (!matchesKeyword) return null;
              const dist = haversineMeters(start, { lat, lon });
              const distPenalty = Math.abs(dist - idealMeters);
              // Proxy notability bonus when no ratings API key is configured
              let notabilityBonus = 0;
              if (tags.website || tags["contact:website"]) notabilityBonus += 350;
              if (tags.opening_hours) notabilityBonus += 250;
              if (tags.wikidata || tags.wikipedia) notabilityBonus += 500;
              if (tags.stars || tags.award) notabilityBonus += 450;
              return {
                name,
                lat,
                lon,
                type: tags.cuisine || tags.amenity || tags.shop || "food",
                score: distPenalty - notabilityBonus,
              };
            })
            .filter((c): c is NonNullable<typeof c> => c !== null)
            .sort((a, b) => a.score - b.score);

          const picked: PlaceSuggestion[] = [];
          for (const c of candidates) {
            const isDup = picked.some(
              (p) =>
                p.shortName.toLowerCase() === c.name.toLowerCase() ||
                haversineMeters(p, c) < 100
            );
            if (isDup) continue;
            picked.push({
              label: `${c.name} (${endQuery})`,
              shortName: c.name,
              lat: c.lat,
              lon: c.lon,
              type: "food",
            });
            if (picked.length >= maxFoodResults) break;
          }
          if (picked.length > 0) return picked;
        }
      } catch {
        // fall through to bounded Nominatim
      }
    }
  }

  // 2. Bounded Nominatim search near start (handles addresses, neighborhoods, directional sub-areas, & local keyword fallback)
  const delta = 0.16; // ~17km box
  const viewbox = `${start.lon - delta},${start.lat + delta},${start.lon + delta},${start.lat - delta}`;

  const queryNominatim = async (q: string, bounded: boolean) => {
    const boundParam = bounded ? "&bounded=1" : "";
    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=8&viewbox=${viewbox}${boundParam}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(5500),
    });
    if (!res.ok) return [];
    const raw = (await res.json()) as {
      display_name: string;
      lat: string;
      lon: string;
      name?: string;
      category?: string;
      type?: string;
    }[];
    // Never accept results outside reasonable running range (prevents cross-country/ocean matches)
    return raw.filter(
      (it) =>
        haversineMeters(start, {
          lat: parseFloat(it.lat),
          lon: parseFloat(it.lon),
        }) <= maxAllowedDist
    );
  };

  try {
    let items = await queryNominatim(endQuery, true);
    if (items.length === 0) {
      items = await queryNominatim(endQuery, false);
    }

    const areaMatch = items.find(
      (it) =>
        (it.category && AREA_CATEGORIES.has(it.category)) ||
        (it.type && AREA_TYPES.has(it.type))
    );

    // Handle directional neighborhood queries like "North Williamsburg", "South Slope", "East Village"
    const dirMatch = endQuery
      .trim()
      .match(
        /^(north|northern|south|southern|east|eastern|west|western|upper|lower)\s+(.+)$/i
      );

    if (dirMatch && !areaMatch) {
      const dirWord = dirMatch[1].toLowerCase();
      const baseArea = dirMatch[2].trim();
      let baseItems = await queryNominatim(baseArea, true);
      if (baseItems.length === 0) {
        baseItems = await queryNominatim(baseArea, false);
      }
      const baseNeighborhood = baseItems.find(
        (it) =>
          (it.category && AREA_CATEGORIES.has(it.category)) ||
          (it.type && AREA_TYPES.has(it.type))
      );

      if (baseNeighborhood) {
        const baseLat = parseFloat(baseNeighborhood.lat);
        const baseLon = parseFloat(baseNeighborhood.lon);
        const bearing = DIRECTION_PREFIX_BEARINGS[dirWord] ?? 0;
        const shifted = destinationPoint({ lat: baseLat, lon: baseLon }, 650, bearing);
        const cleanTitle = endQuery
          .trim()
          .replace(/\b\w/g, (c) => c.toUpperCase());
        return [
          {
            label: `${cleanTitle} (${baseNeighborhood.display_name})`,
            shortName: cleanTitle,
            lat: shifted.lat,
            lon: shifted.lon,
            type: "neighbourhood",
          },
        ];
      }
    }

    if (items.length > 0) {
      // Prefer neighborhoods/parks/piers over random unrelated POIs (schools, clinics, dentists)
      const sorted = items
        .map((it) => {
          const dist = haversineMeters(start, {
            lat: parseFloat(it.lat),
            lon: parseFloat(it.lon),
          });
          const isArea =
            (it.category && AREA_CATEGORIES.has(it.category)) ||
            (it.type && AREA_TYPES.has(it.type));
          const isNoise = it.type && NOISE_POI_TYPES.has(it.type);
          const rankPenalty =
            Math.abs(dist - idealMeters) -
            (isArea ? 1500 : 0) +
            (isNoise ? 3500 : 0);
          return { it, rankPenalty };
        })
        .sort((a, b) => a.rankPenalty - b.rankPenalty);

      if (foodQuery) {
        const picked: PlaceSuggestion[] = [];
        for (const { it } of sorted) {
          const lat = parseFloat(it.lat);
          const lon = parseFloat(it.lon);
          const shortName =
            it.name ||
            it.display_name
              .split(",")
              .slice(0, 2)
              .map((s) => s.trim())
              .join(", ");
          const isDup = picked.some(
            (p) =>
              p.shortName.toLowerCase() === shortName.toLowerCase() ||
              haversineMeters(p, { lat, lon }) < 100
          );
          if (isDup) continue;
          picked.push({
            label: it.display_name,
            shortName,
            lat,
            lon,
            type: "food",
          });
          if (picked.length >= maxFoodResults) break;
        }
        if (picked.length > 0) return picked;
      }

      const top = sorted[0].it;
      const shortName =
        top.name ||
        top.display_name
          .split(",")
          .slice(0, 2)
          .map((s) => s.trim())
          .join(", ");
      return [
        {
          label: top.display_name,
          shortName,
          lat: parseFloat(top.lat),
          lon: parseFloat(top.lon),
          type: top.type,
        },
      ];
    }
  } catch {
    // ignore
  }

  // 3. Final fuzzy keyword fallback via Google Places (handles non-food keywords like "bookstore", "farmers market", "falafel")
  if (!foodQuery && process.env.GOOGLE_PLACES_API_KEY) {
    const fuzzySpots = await resolveFoodViaGooglePlaces(
      start,
      endQuery,
      idealMeters,
      searchRadius,
      maxFoodResults,
      clientIp
    );
    if (fuzzySpots.length > 0) return fuzzySpots;
  }

  return [];
}

async function fetchValhallaFootRoute(
  waypoints: LatLng[],
  elevationPref: ElevationPreference
): Promise<OSRMRoute | null> {
  const valhallaUrl = process.env.VALHALLA_URL?.trim();
  if (!valhallaUrl) return null;

  const useHills =
    elevationPref === "flat" ? 0.1 : elevationPref === "hilly" ? 0.92 : 0.5;

  try {
    const res = await fetch(valhallaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        locations: waypoints.map((p, idx) => ({
          lat: p.lat,
          lon: p.lon,
          type:
            idx === 0 || idx === waypoints.length - 1 ? "break" : "through",
        })),
        costing: "pedestrian",
        costing_options: {
          pedestrian: {
            walkway_factor: 0.72,
            sidewalk_factor: 0.85,
            alley_factor: 1.6,
            use_tracks: 0.9,
            use_hills: useHills,
            use_lit: 0.35,
          },
        },
        units: "kilometers",
      }),
      signal: AbortSignal.timeout(7000),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as {
      trip?: {
        summary?: { length?: number; time?: number };
        legs?: {
          shape?: string;
          maneuvers?: {
            length?: number;
            time?: number;
            street_names?: string[];
            travel_type?: string;
          }[];
        }[];
      };
    };

    const trip = data.trip;
    if (!trip?.legs?.length) return null;

    const allCoordsLonLat: [number, number][] = [];
    const legs: { steps: OSRMStep[] }[] = [];

    for (const leg of trip.legs) {
      if (leg.shape) {
        const decodedLatLon = decodePolyline6(leg.shape);
        for (const [lat, lon] of decodedLatLon) {
          allCoordsLonLat.push([lon, lat]);
        }
      }
      const steps: OSRMStep[] = (leg.maneuvers || []).map((m) => ({
        distance: (m.length ?? 0) * 1000,
        duration: m.time ?? 0,
        name: m.street_names?.[0] || "",
        mode: m.travel_type || "foot",
      }));
      legs.push({ steps });
    }

    if (allCoordsLonLat.length < 2) return null;

    return {
      distance: (trip.summary?.length ?? 0) * 1000,
      duration: trip.summary?.time ?? 0,
      geometry: {
        type: "LineString",
        coordinates: allCoordsLonLat,
      },
      legs,
    };
  } catch {
    return null;
  }
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

async function fetchFootRoute(
  waypoints: LatLng[],
  elevationPref: ElevationPreference = "any"
): Promise<OSRMRoute | null> {
  if (process.env.VALHALLA_URL?.trim()) {
    const valhallaRoute = await fetchValhallaFootRoute(waypoints, elevationPref);
    if (valhallaRoute) return valhallaRoute;
  }
  return fetchOSRMFootRoute(waypoints);
}

interface RouteEnvironmentSignals {
  litPoints: LatLng[];
  unlitPoints: LatLng[];
  trafficSignals: LatLng[];
  waterFountains: LatLng[];
  restrooms: LatLng[];
}

async function fetchRouteEnvironmentSignals(
  center: LatLng,
  radiusMeters: number
): Promise<RouteEnvironmentSignals> {
  const r = Math.min(Math.max(Math.round(radiusMeters), 1500), 7000);
  const query = `
    [out:json][timeout:6];
    (
      node["highway"="street_lamp"](around:${r},${center.lat},${center.lon});
      way["lit"="yes"](around:${r},${center.lat},${center.lon});
      way["lit"="no"](around:${r},${center.lat},${center.lon});
      node["highway"="traffic_signals"](around:${r},${center.lat},${center.lon});
      node["amenity"="drinking_water"](around:${r},${center.lat},${center.lon});
      node["amenity"="toilets"](around:${r},${center.lat},${center.lon});
    );
    out center 220;
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
    if (!res.ok) {
      return {
        litPoints: [],
        unlitPoints: [],
        trafficSignals: [],
        waterFountains: [],
        restrooms: [],
      };
    }
    const data = (await res.json()) as { elements?: OverpassElement[] };
    const litPoints: LatLng[] = [];
    const unlitPoints: LatLng[] = [];
    const trafficSignals: LatLng[] = [];
    const waterFountains: LatLng[] = [];
    const restrooms: LatLng[] = [];

    for (const el of data.elements || []) {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!lat || !lon) continue;
      const tags = el.tags || {};
      if (tags.highway === "traffic_signals") {
        trafficSignals.push({ lat, lon });
      } else if (tags.amenity === "drinking_water") {
        waterFountains.push({ lat, lon });
      } else if (tags.amenity === "toilets") {
        restrooms.push({ lat, lon });
      } else if (tags.lit === "no") {
        unlitPoints.push({ lat, lon });
      } else {
        litPoints.push({ lat, lon });
      }
    }
    return {
      litPoints,
      unlitPoints,
      trafficSignals,
      waterFountains,
      restrooms,
    };
  } catch {
    return {
      litPoints: [],
      unlitPoints: [],
      trafficSignals: [],
      waterFountains: [],
      restrooms: [],
    };
  }
}

function computeNightLightingScore(
  coords: [number, number][],
  surfaceBreakdown: SurfaceBreakdown,
  lighting: RouteEnvironmentSignals
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
  envSignals: RouteEnvironmentSignals,
  elevationPref: ElevationPreference
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
  const approach = await fetchFootRoute([start, entryPt], elevationPref);
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
    envSignals
  );
  const trafficLights = countNearbyPoints(
    approachCoords,
    envSignals.trafficSignals,
    35
  );
  const waterFountains = countNearbyPoints(
    coords,
    envSignals.waterFountains,
    90
  );
  const restrooms = countNearbyPoints(coords, envSignals.restrooms, 100);
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
    trafficLights,
    waterFountains,
    restrooms,
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
      elevationPref = "any",
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

    const clientIp =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip")?.trim() ||
      "unknown";

    // Resolve end destination(s) if user typed a food craving, neighborhood, or address
    let resolvedEnds: PlaceSuggestion[] = endPlace ? [endPlace] : [];
    if (resolvedEnds.length === 0 && endQuery && endQuery.trim().length > 0) {
      resolvedEnds = await resolveEndPlaces(
        start,
        endQuery.trim(),
        desiredMiles,
        4,
        clientIp
      );
    }
    const resolvedEnd: PlaceSuggestion | null = resolvedEnds[0] || null;

    const effectiveMiles = desiredMiles ?? (resolvedEnd ? 2.5 : 3.5);
    const searchRadius = milesToMeters(effectiveMiles) * 0.75;
    const [{ pois: scenicPois, parks, tracks }, envSignals] =
      await Promise.all([
        fetchScenicAndRoutingFeatures(start, searchRadius),
        fetchRouteEnvironmentSignals(start, searchRadius),
      ]);

    const routes: RunRoute[] = [];

    if (resolvedEnds.length > 0) {
      // --- POINT-TO-POINT MODE (supports single destination OR multiple top-rated food spots) ---
      const candidateWaypoints: {
        name: string;
        tagline: string;
        points: LatLng[];
        end: PlaceSuggestion;
      }[] = [];

      if (resolvedEnds.length > 1) {
        // Multi-destination food mode: generate direct + park/scenic variants across top-rated spots
        for (const spot of resolvedEnds) {
          const ratingSnippet =
            spot.rating != null ? ` (★ ${spot.rating.toFixed(1)})` : "";
          candidateWaypoints.push({
            name: `Run to ${spot.shortName}`,
            tagline: `Low-traffic route to ${spot.shortName}${ratingSnippet}`,
            points: [start, spot],
            end: spot,
          });

          const directDist = haversineMeters(start, spot);
          const midPt: LatLng = {
            lat: (start.lat + spot.lat) / 2,
            lon: (start.lon + spot.lon) / 2,
          };
          const spotPark = parks.find(
            (p) =>
              haversineMeters(midPt, p.centroid) <
                Math.max(directDist * 0.8, 1800) &&
              haversineMeters(start, p.centroid) > 150 &&
              haversineMeters(spot, p.centroid) > 150
          );

          if (spotPark) {
            const { entry, interior, exit } = extractParkTraversePoints(
              spotPark,
              start,
              spot
            );
            candidateWaypoints.push({
              name: `${spotPark.name} → ${spot.shortName}`,
              tagline: `Chains through ${spotPark.name} trails to ${spot.shortName}${ratingSnippet}`,
              points: [start, entry, interior, exit, spot],
              end: spot,
            });
          } else {
            const brg = bearingDegrees(start, spot);
            const sideDist = Math.min(Math.max(directDist * 0.22, 300), 1100);
            const wp = destinationPoint(midPt, sideDist, (brg + 80) % 360);
            candidateWaypoints.push({
              name: `Scenic Path to ${spot.shortName}`,
              tagline: `Quiet-street detour to ${spot.shortName}${ratingSnippet}`,
              points: [start, wp, spot],
              end: spot,
            });
          }
        }
      } else {
        const primaryEnd = resolvedEnds[0];
        const directDist = haversineMeters(start, primaryEnd);
        const midPoint: LatLng = {
          lat: (start.lat + primaryEnd.lat) / 2,
          lon: (start.lon + primaryEnd.lon) / 2,
        };
        const corridorParks = parks
          .filter(
            (p) =>
              haversineMeters(midPoint, p.centroid) <
                Math.max(directDist * 0.85, 2200) &&
              haversineMeters(start, p.centroid) > 150 &&
              haversineMeters(primaryEnd, p.centroid) > 150
          )
          .slice(0, 3);

        const corridorPois = scenicPois
          .filter(
            (p) =>
              haversineMeters(midPoint, p) < Math.max(directDist * 0.85, 2000) &&
              haversineMeters(start, p) > 250 &&
              haversineMeters(primaryEnd, p) > 250
          )
          .slice(0, 6);

        candidateWaypoints.push({
          name: `Scenic Path to ${primaryEnd.shortName}`,
          tagline: "Low-traffic pedestrian & park-friendly route",
          points: [start, primaryEnd],
          end: primaryEnd,
        });

        // Park-Interior Chaining: route through entry -> interior -> exit of corridor parks
        for (const park of corridorParks) {
          const { entry, interior, exit } = extractParkTraversePoints(
            park,
            start,
            primaryEnd
          );
          candidateWaypoints.push({
            name: `Through ${park.name}`,
            tagline: `Routes through the interior trails of ${park.name} to ${primaryEnd.shortName}`,
            points: [start, entry, interior, exit, primaryEnd],
            end: primaryEnd,
          });
        }

        if (corridorPois[0]) {
          candidateWaypoints.push({
            name: `Via ${corridorPois[0].name}`,
            tagline: `Detours through ${corridorPois[0].name} for extra greenery`,
            points: [start, corridorPois[0], primaryEnd],
            end: primaryEnd,
          });
        }
        if (corridorPois[1]) {
          candidateWaypoints.push({
            name: `${corridorPois[1].name} Greenway`,
            tagline: `Scenic nature & landmark corridor to ${primaryEnd.shortName}`,
            points: [start, corridorPois[1], primaryEnd],
            end: primaryEnd,
          });
        }

        // Ensure up to 9 distinct route options even when Overpass has fewer corridor POIs
        if (candidateWaypoints.length < 9) {
          const brg = bearingDegrees(start, primaryEnd);
          const sideDist =
            desiredMiles && milesToMeters(desiredMiles) > directDist * 1.25
              ? Math.min((milesToMeters(desiredMiles) - directDist) * 0.45, 3500)
              : Math.min(Math.max(directDist * 0.25, 350), 1400);

          const arcs = [
            { angle: 85, mult: 1.0, name: "Quiet Parkside Detour", tagline: `Alternative low-traffic path to ${primaryEnd.shortName}` },
            { angle: 275, mult: 1.0, name: "Alternate Scenic Corridor", tagline: `Secondary quiet-street route to ${primaryEnd.shortName}` },
            { angle: 55, mult: 1.35, name: "Extended Greenway Loop-In", tagline: `Longer low-traffic approach to ${primaryEnd.shortName}` },
            { angle: 305, mult: 1.35, name: "Wide Neighborhood Path", tagline: `Calm residential & trail route to ${primaryEnd.shortName}` },
            { angle: 110, mult: 0.75, name: "Inner Side-Street Path", tagline: `Direct quiet-street alternative to ${primaryEnd.shortName}` },
            { angle: 250, mult: 0.75, name: "Westside Trail Connector", tagline: `Low-traffic connector to ${primaryEnd.shortName}` },
            { angle: 40, mult: 1.6, name: "Outer Scenic Arc", tagline: `Longer scenic run to ${primaryEnd.shortName}` },
            { angle: 320, mult: 1.6, name: "Parkway Bypass Route", tagline: `Avoids main roads on the way to ${primaryEnd.shortName}` },
          ];

          for (const arc of arcs) {
            if (candidateWaypoints.length >= 9) break;
            const wp = destinationPoint(midPoint, sideDist * arc.mult, (brg + arc.angle) % 360);
            candidateWaypoints.push({
              name: arc.name,
              tagline: arc.tagline,
              points: [start, wp, primaryEnd],
              end: primaryEnd,
            });
          }
        }
      }

      const routeResults = await Promise.all(
        candidateWaypoints.map((c) => fetchFootRoute(c.points, elevationPref))
      );

      routeResults.forEach((osrm, idx) => {
        if (!osrm) return;
        const cand = candidateWaypoints[idx];
        const coords: [number, number][] = osrm.geometry.coordinates.map(
          ([lon, lat]) => [lat, lon]
        );
        const distMiles = metersToMiles(osrm.distance);
        const analysis = analyzeRouteSurfaceAndScenery(osrm, coords, scenicPois);
        const night = computeNightLightingScore(
          coords,
          analysis.surfaceBreakdown,
          envSignals
        );
        const trafficLights = countNearbyPoints(
          coords,
          envSignals.trafficSignals,
          35
        );
        const waterFountains = countNearbyPoints(
          coords,
          envSignals.waterFountains,
          90
        );
        const restrooms = countNearbyPoints(coords, envSignals.restrooms, 100);
        const estMinutes = Math.max(5, Math.round(distMiles * 9.0));

        routes.push({
          id: `p2p-${idx}-${Math.round(osrm.distance)}`,
          name: cand.name,
          tagline: cand.tagline,
          mode: "point-to-point",
          distanceMiles: Math.round(distMiles * 100) / 100,
          estimatedMinutes: estMinutes,
          trafficFreePct: analysis.trafficFreePct,
          sceneryScore: analysis.sceneryScore,
          nightScore: night.nightScore,
          nightLabel: night.nightLabel,
          uniquePathPct: preferLoop ? analysis.uniquePathPct : undefined,
          trafficLights,
          waterFountains,
          restrooms,
          surfaceBreakdown: analysis.surfaceBreakdown,
          highlights: analysis.highlights,
          start,
          end: cand.end,
          destinationFoodOrArea: endQuery || cand.end.shortName,
          coordinates: coords,
          pois: [
            ...analysis.nearbyPois.slice(0, 6),
            {
              name: cand.end.shortName,
              category: cand.end.type === "food" ? "food" : "landmark",
              lat: cand.end.lat,
              lon: cand.end.lon,
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

      // Pass 1: Fetch loops + Track-lap route (if a running track is nearby) in parallel
      const trackPromise =
        tracks.length > 0
          ? buildTrackLapRoute(
              start,
              tracks[0],
              targetMeters,
              scenicPois,
              envSignals,
              elevationPref
            )
          : Promise.resolve(null);

      const [pass1Results, trackRoute] = await Promise.all([
        Promise.all(
          loopTemplates.map((t) => fetchFootRoute(t.waypoints, elevationPref))
        ),
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
          promise: fetchFootRoute(scaledWaypoints, elevationPref),
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
          envSignals
        );
        const trafficLights = countNearbyPoints(
          coords,
          envSignals.trafficSignals,
          35
        );
        const waterFountains = countNearbyPoints(
          coords,
          envSignals.waterFountains,
          90
        );
        const restrooms = countNearbyPoints(coords, envSignals.restrooms, 100);
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
          trafficLights,
          waterFountains,
          restrooms,
          surfaceBreakdown: analysis.surfaceBreakdown,
          highlights: analysis.highlights,
          start,
          end: start,
          coordinates: coords,
          pois: analysis.nearbyPois.slice(0, 6),
        });
      });
    }

    // Fetch real elevation stats in parallel BEFORE final ranking so elevation preference works accurately
    await Promise.all(
      routes.map(async (r) => {
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

    // Cost-weighted multi-objective ranking:
    // prioritizes car-free & low-traffic paths, scenery, minimal traffic lights,
    // unique roads (for loops), elevation preference, water/restrooms on long runs,
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
        preferLoop && !r.lapInfo ? (r.uniquePathPct ?? 100) * 0.3 : 0;
      const nightTieBreaker = (r.nightScore ?? 60) * 0.08;
      const trackMatchBonus = r.lapInfo && rangePenalty === 0 ? 6 : 0;

      // Penalize stop-and-go traffic-light crossings per mile
      const lightsPerMile =
        (r.trafficLights ?? 0) / Math.max(0.5, r.distanceMiles);
      const trafficLightPenalty = Math.min(18, lightsPerMile * 2.4);

      // Elevation preference bonus/penalty (Flat vs Hilly)
      let elevationAdjustment = 0;
      if (r.elevationGainFt != null && r.distanceMiles > 0) {
        const ftPerMile = r.elevationGainFt / r.distanceMiles;
        if (elevationPref === "flat") {
          elevationAdjustment =
            ftPerMile <= 35 ? 10 : -Math.min(20, (ftPerMile - 35) * 0.22);
        } else if (elevationPref === "hilly") {
          elevationAdjustment =
            Math.min(18, ftPerMile * 0.16) - (ftPerMile < 25 ? 8 : 0);
        }
      }

      // Bonus for drinking water & restrooms on longer runs (>= 4 miles)
      const amenityBonus =
        r.distanceMiles >= 4
          ? Math.min(
              4,
              (r.waterFountains ?? 0) * 1.2 + (r.restrooms ?? 0) * 0.8
            )
          : 0;

      // Slight food rating boost when comparing multiple food spots
      const foodRatingBonus =
        r.end.rating != null ? (r.end.rating - 4.0) * 5 : 0;

      return (
        r.trafficFreePct * 0.46 +
        r.sceneryScore * 0.32 +
        repeatBonus +
        nightTieBreaker +
        trackMatchBonus +
        elevationAdjustment +
        amenityBonus +
        foodRatingBonus -
        trafficLightPenalty -
        rangePenalty
      );
    };

    routes.sort((a, b) => scoreRoute(b) - scoreRoute(a));

    // Spatial polyline overlap deduplication: ensure top 9 routes are genuinely distinct corridors
    // (preserve routes going to different food destinations even if they share the start corridor)
    const uniqueRoutes: RunRoute[] = [];
    for (const r of routes) {
      const isDup = uniqueRoutes.some((u) => {
        const differentDestination =
          r.mode === "point-to-point" &&
          u.mode === "point-to-point" &&
          haversineMeters(u.end, r.end) > 120;
        if (differentDestination) return false;

        const scalarNearDup =
          Math.abs(u.distanceMiles - r.distanceMiles) < 0.05 &&
          u.trafficFreePct === r.trafficFreePct &&
          u.sceneryScore === r.sceneryScore;
        if (scalarNearDup) return true;

        return computePolylineOverlap(r.coordinates, u.coordinates, 60) >= 0.72;
      });
      if (!isDup) uniqueRoutes.push(r);
      if (uniqueRoutes.length >= 9) break;
    }

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
