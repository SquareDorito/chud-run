import { NextRequest, NextResponse } from "next/server";
import type { PlaceSuggestion } from "@/lib/types";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT = "ChudRun/1.0 (scenic running route planner)";

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

function formatShortName(item: NominatimItem): string {
  const a = item.address;
  if (item.name && (a?.city || a?.town || a?.suburb || a?.neighbourhood)) {
    const area = a.neighbourhood || a.suburb || a.city || a.town;
    return area && area !== item.name ? `${item.name}, ${area}` : item.name;
  }
  const parts = item.display_name.split(",").map((s) => s.trim());
  return parts.slice(0, 2).join(", ");
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const lat = searchParams.get("lat");
  const lon = searchParams.get("lon");

  try {
    if (lat && lon) {
      const url = `${NOMINATIM_BASE}/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=jsonv2&addressdetails=1`;
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(6000),
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
      return NextResponse.json({ places: [place] });
    }

    if (!q || q.length < 2) {
      return NextResponse.json({ places: [] });
    }

    const nearLat = searchParams.get("nearLat");
    const nearLon = searchParams.get("nearLon");
    let viewboxParam = "";
    if (nearLat && nearLon) {
      const nLat = parseFloat(nearLat);
      const nLon = parseFloat(nearLon);
      if (!Number.isNaN(nLat) && !Number.isNaN(nLon)) {
        const delta = 0.18; // ~20km box
        viewboxParam = `&viewbox=${nLon - delta},${nLat + delta},${nLon + delta},${nLat - delta}`;
      }
    }

    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=6${viewboxParam}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) {
      return NextResponse.json({ places: [] }, { status: 200 });
    }

    const items = (await res.json()) as NominatimItem[];
    const places: PlaceSuggestion[] = items.map((item) => ({
      label: item.display_name,
      shortName: formatShortName(item),
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon),
      type: item.type,
    }));

    return NextResponse.json({ places });
  } catch {
    return NextResponse.json({ places: [] }, { status: 200 });
  }
}
