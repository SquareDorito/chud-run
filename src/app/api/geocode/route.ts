import { NextRequest, NextResponse } from "next/server";
import type { PlaceSuggestion } from "@/lib/types";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const PHOTON_BASE = "https://photon.komoot.io/api/";
const USER_AGENT = "ChudRun/1.0 (scenic running route planner)";

const GEOCODE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const GEOCODE_CACHE_MAX = 400;
const geocodeCache = new Map<
  string,
  { expiresAt: number; places: PlaceSuggestion[] }
>();

function setGeocodeCache(key: string, places: PlaceSuggestion[]) {
  if (geocodeCache.size >= GEOCODE_CACHE_MAX) {
    const oldest = geocodeCache.keys().next().value;
    if (oldest) geocodeCache.delete(oldest);
  }
  geocodeCache.set(key, {
    expiresAt: Date.now() + GEOCODE_CACHE_TTL_MS,
    places,
  });
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
  nearLon?: number
): Promise<PlaceSuggestion[]> {
  try {
    const bias =
      nearLat != null && nearLon != null
        ? `&lat=${nearLat}&lon=${nearLon}`
        : "";
    const url = `${PHOTON_BASE}?q=${encodeURIComponent(q)}&limit=6${bias}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(2200),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { features?: PhotonFeature[] };
    const seen = new Set<string>();
    const places: PlaceSuggestion[] = [];
    for (const f of data.features || []) {
      const place = formatPhotonPlace(f);
      if (!place) continue;
      const key = `${place.shortName.toLowerCase()}|${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      places.push(place);
    }
    return places;
  } catch {
    return [];
  }
}

async function searchNominatim(
  q: string,
  nearLat?: number,
  nearLon?: number
): Promise<PlaceSuggestion[]> {
  try {
    let viewboxParam = "";
    if (nearLat != null && nearLon != null) {
      const delta = 0.18; // ~20km box
      viewboxParam = `&viewbox=${nearLon - delta},${nearLat + delta},${nearLon + delta},${nearLat - delta}`;
    }
    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=6${viewboxParam}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const items = (await res.json()) as NominatimItem[];
    return items.map((item) => ({
      label: item.display_name,
      shortName: formatShortName(item),
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon),
      type: item.type,
    }));
  } catch {
    return [];
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
      const revKey = `rev:${nLat.toFixed(4)},${nLon.toFixed(4)}`;
      const cached = geocodeCache.get(revKey);
      if (cached && cached.expiresAt > Date.now()) {
        return NextResponse.json({ places: cached.places });
      }
      const url = `${NOMINATIM_BASE}/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=jsonv2&addressdetails=1`;
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(3500),
      });
      if (!res.ok) {
        return NextResponse.json({ places: [] }, { status: 200 });
      }
      const item = (await res.json()) as NominatimItem;
      const place: PlaceSuggestion = {
        label: item.display_name,
        shortName: formatShortName(item),
        lat: parseFloat(item.lat),
        lon: parseFloat(item.lon),
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
    const parsedLat = nearLatRaw ? parseFloat(nearLatRaw) : NaN;
    const parsedLon = nearLonRaw ? parseFloat(nearLonRaw) : NaN;
    const nearLat = Number.isNaN(parsedLat) ? undefined : parsedLat;
    const nearLon = Number.isNaN(parsedLon) ? undefined : parsedLon;

    const cacheKey = `q:${q.toLowerCase()}|${nearLat != null ? nearLat.toFixed(2) : ""},${nearLon != null ? nearLon.toFixed(2) : ""}`;
    const cached = geocodeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json({ places: cached.places });
    }

    // Photon primary (fast typeahead + native proximity bias); Nominatim fallback for misses or exact street numbers
    let places = await searchPhoton(q, nearLat, nearLon);
    if (places.length === 0) {
      places = await searchNominatim(q, nearLat, nearLon);
    }

    if (places.length > 0) {
      setGeocodeCache(cacheKey, places);
    }
    return NextResponse.json({ places });
  } catch {
    return NextResponse.json({ places: [] }, { status: 200 });
  }
}
