export interface LatLng {
  lat: number;
  lon: number;
}

export interface PlaceSuggestion {
  label: string;
  shortName: string;
  lat: number;
  lon: number;
  type?: string;
}

export interface ScenicPOI {
  name: string;
  category: "park" | "water" | "viewpoint" | "landmark" | "food";
  lat: number;
  lon: number;
}

export interface SurfaceBreakdown {
  carFreePct: number;
  quietStreetPct: number;
  mainRoadPct: number;
}

export interface RunRoute {
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
  lapInfo?: {
    laps: number;
    featureName: string;
    kind: "track" | "park-loop";
  };
  surfaceBreakdown: SurfaceBreakdown;
  highlights: string[];
  start: PlaceSuggestion;
  end: PlaceSuggestion;
  destinationFoodOrArea?: string;
  /** Full [lat, lon] coordinates of the route */
  coordinates: [number, number][];
  /** Notable POIs along or near this route */
  pois: ScenicPOI[];
}

export interface RouteSearchRequest {
  start: PlaceSuggestion;
  minMiles?: number | null;
  maxMiles?: number | null;
  endQuery?: string;
  endPlace?: PlaceSuggestion | null;
  preferLoop?: boolean;
}

export interface RouteSearchResponse {
  routes: RunRoute[];
  resolvedEnd?: PlaceSuggestion | null;
  note?: string;
}
