import { NextRequest, NextResponse } from "next/server";
import { haversineMeters, metersToMiles, milesToMeters } from "@/lib/geo";
import type { PlaceSuggestion } from "@/lib/types";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const PHOTON_BASE = "https://photon.komoot.io/api/";
const PHOTON_REVERSE_BASE = "https://photon.komoot.io/reverse";
const USER_AGENT = "ChudRun/1.0 (scenic running route planner)";

const GEOCODE_FOOD_HINT_REGEX =
  /\b(pizza|pizzeria|taco|tacos|coffee|cafe|espresso|latte|matcha|tea|ramen|sushi|noodle|burger|burgers|bagel|bagels|bakery|pastry|donut|donuts|ice cream|gelato|boba|smoothie|sandwich|deli|brunch|breakfast|brewery|bar|pub|restaurant|food|thai|indian|italian|korean|mexican|pho|dim sum|dumpling|falafel)\b/i;

const NON_FOOD_OSM_VALUES = new Set([
  "car_repair",
  "car",
  "car_parts",
  "tyres",
  "fuel",
  "parking",
  "dentist",
  "doctors",
  "clinic",
  "hospital",
  "pharmacy",
  "school",
  "college",
  "university",
  "bank",
  "atm",
  "funeral_directors",
  "storage_rental",
  "laundry",
  "dry_cleaning",
]);

function computeBoundingBox(lat: number, lon: number, radiusMeters: number) {
  const dLat = radiusMeters / 111320;
  const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  const dLon = radiusMeters / (111320 * cosLat);
  return {
    minLon: lon - dLon,
    minLat: lat - dLat,
    maxLon: lon + dLon,
    maxLat: lat + dLat,
  };
}

function queryTokenMatchScore(query: string, text: string): number {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return 0;
  const hay = text.toLowerCase();
  let matched = 0;
  for (const t of tokens) {
    if (hay.includes(t)) matched++;
  }
  return matched / tokens.length;
}

const GEOCODE_CACHE_MAX = 800;
const geocodeCache = new Map<string, PlaceSuggestion[]>();

function getGeocodeCache(key: string): PlaceSuggestion[] | undefined {
  const hit = geocodeCache.get(key);
  if (!hit) return undefined;
  // LRU refresh: move to most-recently-used position
  geocodeCache.delete(key);
  geocodeCache.set(key, hit);
  return hit;
}

function setGeocodeCache(key: string, places: PlaceSuggestion[]) {
  if (geocodeCache.has(key)) {
    geocodeCache.delete(key);
  } else if (geocodeCache.size >= GEOCODE_CACHE_MAX) {
    const oldest = geocodeCache.keys().next().value;
    if (oldest) geocodeCache.delete(oldest);
  }
  geocodeCache.set(key, places);
}

interface NominatimItem {
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  name?: string;
  address?: {
    road?: string;
    neighbourhood?: string;
    suburb?: string;
    city?: string;
    town?: string;
    village?: string;
    state?: string;
    park?: string;
    amenity?: string;
  };
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    housenumber?: string;
    street?: string;
    district?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
    osm_value?: string;
  };
}

function formatShortName(item: NominatimItem): string {
  const a = item.address;
  if (item.name && (a?.city || a?.town || a?.suburb || a?.neighbourhood)) {
    const area = a.neighbourhood || a.suburb || a.city || a.town;
    return area && area !== item.name ? `${item.name}, ${area}` : item.name;
  }
  const parts = item.display_name.split(",").map((s) => s.trim());
  return parts.slice(0, 2).join(", ");
}

function formatPhotonPlace(f: PhotonFeature): PlaceSuggestion | null {
  const coords = f.geometry?.coordinates;
  const p = f.properties;
  if (!coords || coords.length < 2 || !p) return null;
  const [lon, lat] = coords;
  const streetLine = [p.housenumber, p.street].filter(Boolean).join(" ").trim();
  const primary = p.name || streetLine;
  if (!primary) return null;
  const area = p.district || p.city || p.county || p.state || "";
  const shortName =
    area && area.toLowerCase() !== primary.toLowerCase()
      ? `${primary}, ${area}`
      : primary;
  const labelParts = [
    p.name,
    streetLine && streetLine !== p.name ? streetLine : "",
    p.district,
    p.city,
    p.state,
  ].filter(Boolean);
  const label = Array.from(new Set(labelParts)).join(", ") || shortName;
  return {
    label,
    shortName,
    lat,
    lon,
    type: p.osm_value,
  };
}

async function searchPhoton(
  q: string,
  nearLat?: number,
  nearLon?: number,
  maxMeters?: number
): Promise<PlaceSuggestion[]> {
  try {
    const hasOrigin = nearLat != null && nearLon != null;
    const bias = hasOrigin ? `&lat=${nearLat}&lon=${nearLon}` : "";
    let bboxParam = "";
    if (hasOrigin && maxMeters != null) {
      const box = computeBoundingBox(nearLat, nearLon, maxMeters);
      bboxParam = `&bbox=${box.minLon.toFixed(5)},${box.minLat.toFixed(5)},${box.maxLon.toFixed(5)},${box.maxLat.toFixed(5)}`;
    }
    const limit = maxMeters != null ? 15 : 6;
    const url = `${PHOTON_BASE}?q=${encodeURIComponent(q)}&limit=${limit}${bias}${bboxParam}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(2200),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { features?: PhotonFeature[] };
    const isFoodLike = GEOCODE_FOOD_HINT_REGEX.test(q);
    const seen = new Set<string>();
    const scored: { place: PlaceSuggestion; rank: number }[] = [];

    for (const f of data.features || []) {
      const place = formatPhotonPlace(f);
      if (!place) continue;
      const osmVal = (f.properties?.osm_value || "").toLowerCase();
      if (isFoodLike && NON_FOOD_OSM_VALUES.has(osmVal)) {
        continue;
      }

      let distMeters: number | undefined;
      if (hasOrigin) {
        distMeters = haversineMeters(
          { lat: nearLat, lon: nearLon },
          { lat: place.lat, lon: place.lon }
        );
        if (maxMeters != null && distMeters > maxMeters) {
          continue;
        }
        place.distanceMiles = Math.round(metersToMiles(distMeters) * 10) / 10;
      }

      const key = `${place.shortName.toLowerCase()}|${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const tokenScore = queryTokenMatchScore(
        q,
        `${place.shortName} ${place.label}`
      );
      const distPenalty = distMeters != null ? distMeters / 25000 : 0;
      scored.push({ place, rank: tokenScore * 3 - distPenalty });
    }

    if (hasOrigin) {
      scored.sort((a, b) => b.rank - a.rank);
    }

    return scored.slice(0, 6).map((s) => s.place);
  } catch {
    return [];
  }
}

async function searchNominatim(
  q: string,
  nearLat?: number,
  nearLon?: number,
  maxMeters?: number
): Promise<PlaceSuggestion[]> {
  try {
    const hasOrigin = nearLat != null && nearLon != null;
    let viewboxParam = "";
    if (hasOrigin) {
      if (maxMeters != null) {
        const box = computeBoundingBox(nearLat, nearLon, maxMeters);
        viewboxParam = `&viewbox=${box.minLon.toFixed(5)},${box.maxLat.toFixed(5)},${box.maxLon.toFixed(5)},${box.minLat.toFixed(5)}&bounded=1`;
      } else {
        const delta = 0.18; // ~20km box
        viewboxParam = `&viewbox=${nearLon - delta},${nearLat + delta},${nearLon + delta},${nearLat - delta}`;
      }
    }
    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=8${viewboxParam}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const items = (await res.json()) as NominatimItem[];
    const places: PlaceSuggestion[] = [];
    for (const item of items) {
      const lat = parseFloat(item.lat);
      const lon = parseFloat(item.lon);
      let distanceMiles: number | undefined;
      if (hasOrigin) {
        const dist = haversineMeters(
          { lat: nearLat, lon: nearLon },
          { lat, lon }
        );
        if (maxMeters != null && dist > maxMeters) continue;
        distanceMiles = Math.round(metersToMiles(dist) * 10) / 10;
      }
      places.push({
        label: item.display_name,
        shortName: formatShortName(item),
        lat,
        lon,
        type: item.type,
        distanceMiles,
      });
      if (places.length >= 6) break;
    }
    return places;
  } catch {
    return [];
  }
}

async function reversePhoton(
  lat: number,
  lon: number
): Promise<PlaceSuggestion | null> {
  try {
    const url = `${PHOTON_REVERSE_BASE}?lat=${lat}&lon=${lon}&limit=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(1800),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { features?: PhotonFeature[] };
    const feat = data.features?.[0];
    if (!feat) return null;
    const formatted = formatPhotonPlace(feat);
    if (!formatted) return null;
    // Preserve exact user GPS/pin coordinates rather than snapped building centroid
    return { ...formatted, lat, lon };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const lat = searchParams.get("lat");
  const lon = searchParams.get("lon");

  try {
    if (lat && lon) {
      const nLat = parseFloat(lat);
      const nLon = parseFloat(lon);
      if (Number.isNaN(nLat) || Number.isNaN(nLon)) {
        return NextResponse.json({ places: [] }, { status: 200 });
      }
      const revKey = `rev:${nLat.toFixed(4)},${nLon.toFixed(4)}`;
      const cached = getGeocodeCache(revKey);
      if (cached) {
        return NextResponse.json({ places: cached });
      }

      // Photon reverse primary (~150ms); Nominatim fallback if Photon misses
      const photonPlace = await reversePhoton(nLat, nLon);
      if (photonPlace) {
        setGeocodeCache(revKey, [photonPlace]);
        return NextResponse.json({ places: [photonPlace] });
      }

      const url = `${NOMINATIM_BASE}/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=jsonv2&addressdetails=1`;
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        return NextResponse.json({ places: [] }, { status: 200 });
      }
      const item = (await res.json()) as NominatimItem;
      const place: PlaceSuggestion = {
        label: item.display_name,
        shortName: formatShortName(item),
        lat: nLat,
        lon: nLon,
        type: item.type,
      };
      setGeocodeCache(revKey, [place]);
      return NextResponse.json({ places: [place] });
    }

    if (!q || q.length < 2) {
      return NextResponse.json({ places: [] });
    }

    const nearLatRaw = searchParams.get("nearLat");
    const nearLonRaw = searchParams.get("nearLon");
    const maxMilesRaw = searchParams.get("maxMiles");
    const parsedLat = nearLatRaw ? parseFloat(nearLatRaw) : NaN;
    const parsedLon = nearLonRaw ? parseFloat(nearLonRaw) : NaN;
    const parsedMaxMiles = maxMilesRaw ? parseFloat(maxMilesRaw) : NaN;
    const nearLat = Number.isNaN(parsedLat) ? undefined : parsedLat;
    const nearLon = Number.isNaN(parsedLon) ? undefined : parsedLon;
    const maxMiles =
      !Number.isNaN(parsedMaxMiles) && parsedMaxMiles > 0
        ? Math.min(Math.max(parsedMaxMiles, 0.5), 30)
        : undefined;
    const maxMeters =
      nearLat != null && nearLon != null && maxMiles != null
        ? milesToMeters(maxMiles)
        : undefined;

    const cacheKey = `q:${q.toLowerCase()}|${nearLat != null ? nearLat.toFixed(2) : ""},${nearLon != null ? nearLon.toFixed(2) : ""}|${maxMiles != null ? maxMiles.toFixed(1) : ""}`;
    const cached = getGeocodeCache(cacheKey);
    if (cached) {
      return NextResponse.json({ places: cached });
    }

    // Photon primary (fast typeahead + native proximity & bbox); Nominatim fallback for misses or exact street numbers
    let places = await searchPhoton(q, nearLat, nearLon, maxMeters);
    if (places.length === 0) {
      places = await searchNominatim(q, nearLat, nearLon, maxMeters);
    }

    if (places.length > 0) {
      setGeocodeCache(cacheKey, places);
    }
    return NextResponse.json({ places });
  } catch {
    return NextResponse.json({ places: [] }, { status: 200 });
  }
}
