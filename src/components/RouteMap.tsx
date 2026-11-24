"use client";

import { useEffect, useRef, useState } from "react";
import type L from "leaflet";
import type { PlaceSuggestion, RunRoute } from "@/lib/types";

interface RouteMapProps {
  routes: RunRoute[];
  activeRouteId: string | null;
  onSelectRoute?: (id: string) => void;
  onPickStart?: (lat: number, lon: number) => void;
  startLocation?: PlaceSuggestion | null;
  center?: [number, number];
}

export default function RouteMap({
  routes,
  activeRouteId,
  onSelectRoute,
  onPickStart,
  startLocation,
  center = [40.7681, -73.9819], // Central Park South default before user picks start
}: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const leafletRef = useRef<typeof L | null>(null);
  const initialCenterRef = useRef(center);
  const onPickStartRef = useRef(onPickStart);
  const hasRoutesRef = useRef(routes.length > 0);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    onPickStartRef.current = onPickStart;
  }, [onPickStart]);

  useEffect(() => {
    hasRoutesRef.current = routes.length > 0;
  }, [routes.length]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (!containerRef.current || mapRef.current) return;
      const leaflet = (await import("leaflet")).default;
      await import("leaflet/dist/leaflet.css");

      if (cancelled || !containerRef.current) return;
      leafletRef.current = leaflet;

      const map = leaflet.map(containerRef.current, {
        center: initialCenterRef.current,
        zoom: 13,
        zoomControl: false,
      });

      const tileUrl =
        process.env.NEXT_PUBLIC_MAP_TILES_URL ||
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}";

      leaflet
        .tileLayer(tileUrl, {
          attribution:
            "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, TomTom, Intermap, iPC, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), and the GIS User Community",
          maxZoom: 19,
        })
        .addTo(map);

      leaflet.control.zoom({ position: "bottomright" }).addTo(map);

      map.on("click", (e: L.LeafletMouseEvent) => {
        if (!onPickStartRef.current || hasRoutesRef.current) return;
        onPickStartRef.current(e.latlng.lat, e.latlng.lng);
      });

      const group = leaflet.layerGroup().addTo(map);
      mapRef.current = map;
      layerGroupRef.current = group;
      setMapReady(true);
    }

    init();

    return () => {
      cancelled = true;
      setMapReady(false);
      if (mapRef.current) {
        mapRef.current.stop();
        mapRef.current.off();
        mapRef.current.remove();
        mapRef.current = null;
        layerGroupRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    const group = layerGroupRef.current;
    const leaflet = leafletRef.current;
    if (!map || !group || !leaflet || !map.getContainer()?.isConnected) return;

    map.stop();
    group.clearLayers();

    if (routes.length === 0) {
      if (startLocation) {
        const startIcon = leaflet.divIcon({
          className: "",
          iconSize: [28, 28],
          iconAnchor: [14, 14],
          html: `<div style="width:28px;height:28px;border-radius:9999px;background:#10B981;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:12px;">S</div>`,
        });
        leaflet
          .marker([startLocation.lat, startLocation.lon], { icon: startIcon })
          .bindTooltip(`Start: ${startLocation.shortName}`, {
            direction: "top",
          })
          .addTo(group);
        map.setView([startLocation.lat, startLocation.lon], 15, {
          animate: false,
        });
      } else {
        map.setView(center, 13, { animate: false });
      }
      return;
    }

    const activeRoute =
      routes.find((r) => r.id === activeRouteId) || routes[0];

    // Draw inactive routes first
    for (const r of routes) {
      if (r.id === activeRoute.id || r.coordinates.length < 2) continue;
      const line = leaflet.polyline(r.coordinates, {
        color: "#94A3B8",
        weight: 4,
        opacity: 0.65,
        dashArray: "6 6",
      });
      if (onSelectRoute) {
        line.on("click", () => onSelectRoute(r.id));
      }
      line.addTo(group);
    }

    // Draw active route with white casing + Strava orange
    if (activeRoute.coordinates.length >= 2) {
      leaflet
        .polyline(activeRoute.coordinates, {
          color: "#FFFFFF",
          weight: 9,
          opacity: 0.9,
          lineCap: "round",
          lineJoin: "round",
        })
        .addTo(group);

      leaflet
        .polyline(activeRoute.coordinates, {
          color: "#FC4C02",
          weight: 5,
          opacity: 1,
          lineCap: "round",
          lineJoin: "round",
        })
        .addTo(group);

      // Start marker
      const startIcon = leaflet.divIcon({
        className: "",
        iconSize: [26, 26],
        iconAnchor: [13, 13],
        html: `<div style="width:26px;height:26px;border-radius:9999px;background:#10B981;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:11px;">S</div>`,
      });
      leaflet
        .marker([activeRoute.start.lat, activeRoute.start.lon], {
          icon: startIcon,
        })
        .bindTooltip(`Start: ${activeRoute.start.shortName}`, {
          direction: "top",
        })
        .addTo(group);

      // End marker if point-to-point
      if (activeRoute.mode === "point-to-point") {
        const endIcon = leaflet.divIcon({
          className: "",
          iconSize: [28, 28],
          iconAnchor: [14, 14],
          html: `<div style="width:28px;height:28px;border-radius:9999px;background:#FC4C02;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:11px;">E</div>`,
        });
        leaflet
          .marker([activeRoute.end.lat, activeRoute.end.lon], {
            icon: endIcon,
          })
          .bindTooltip(`Finish: ${activeRoute.end.shortName}`, {
            direction: "top",
          })
          .addTo(group);
      }

      // Scenic POI markers
      for (const poi of activeRoute.pois.slice(0, 5)) {
        if (poi.category === "food") continue;
        const emoji =
          poi.category === "water"
            ? "💧"
            : poi.category === "viewpoint"
            ? "📸"
            : poi.category === "landmark"
            ? "🏛️"
            : "🌳";
        const poiIcon = leaflet.divIcon({
          className: "",
          iconSize: [24, 24],
          iconAnchor: [12, 12],
          html: `<div style="width:24px;height:24px;border-radius:9999px;background:#fff;border:2px solid #10B981;box-shadow:0 2px 6px rgba(0,0,0,0.2);display:flex;align-items:center;justify-content:center;font-size:12px;">${emoji}</div>`,
        });
        leaflet
          .marker([poi.lat, poi.lon], { icon: poiIcon })
          .bindTooltip(poi.name, { direction: "top" })
          .addTo(group);
      }

      map.invalidateSize({ animate: false });
      const bounds = leaflet.latLngBounds(activeRoute.coordinates);
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16, animate: false });
    }
  }, [mapReady, routes, activeRouteId, startLocation, center, onSelectRoute]);

  return (
    <div className="relative w-full h-full">
      <div
        ref={containerRef}
        className={`w-full h-full z-0 ${onPickStart && routes.length === 0 ? "cursor-crosshair" : ""}`}
      />
      {onPickStart && routes.length === 0 && (
        <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 z-[400] px-3 py-1.5 rounded-full bg-white/95 backdrop-blur-xs shadow-md border border-slate-200/80 text-[11px] font-semibold text-slate-700 whitespace-nowrap">
          {startLocation
            ? "Tap anywhere on the map to move Start"
            : "Tap anywhere on the map to set Start"}
        </div>
      )}
    </div>
  );
}
