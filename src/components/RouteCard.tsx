"use client";

import { Download, ExternalLink, MessageCircle, Moon, Mountain, Trees } from "lucide-react";
import {
  buildAppleMapsWalkingUrl,
  buildGoogleMapsWalkingUrl,
  generateGPX,
} from "@/lib/share";
import type { RunRoute } from "@/lib/types";

interface RouteCardProps {
  route: RunRoute;
  isActive: boolean;
  onSelect: () => void;
  onShare: (route: RunRoute) => void;
}

export default function RouteCard({
  route,
  isActive,
  onSelect,
  onShare,
}: RouteCardProps) {
  const handleDownloadGPX = (e: React.MouseEvent) => {
    e.stopPropagation();
    const gpx = generateGPX(route);
    const blob = new Blob([gpx], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${route.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.gpx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
      className={`w-full text-left rounded-2xl p-4 transition-all cursor-pointer border ${
        isActive
          ? "bg-white border-[#FC4C02] ring-2 ring-[#FC4C02]/15 shadow-md"
          : "bg-white border-slate-200 hover:border-slate-300 shadow-xs"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <span
              className={`text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                route.mode === "loop"
                  ? "bg-orange-50 text-[#FC4C02]"
                  : "bg-emerald-50 text-emerald-700"
              }`}
            >
              {route.mode === "loop"
                ? "Scenic Loop"
                : route.destinationFoodOrArea
                ? `Run → ${route.end.shortName}${
                    route.end.rating != null
                      ? ` ★ ${route.end.rating.toFixed(1)}`
                      : ""
                  }`
                : "Point-to-Point"}
            </span>
            {route.lapInfo && (
              <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
                {route.lapInfo.laps} {route.lapInfo.kind === "track" ? "Track" : "Park"}{" "}
                {route.lapInfo.laps === 1 ? "Lap" : "Laps"}
              </span>
            )}
          </div>
          <h3 className="font-bold text-slate-900 text-base leading-snug">
            {route.name}
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">{route.tagline}</p>
        </div>
      </div>

      {/* Strava-style Stats Strip */}
      <div className="grid grid-cols-4 gap-2 py-2.5 my-2.5 border-y border-slate-100">
        <div>
          <div className="text-[10px] font-semibold uppercase text-slate-400">
            Dist
          </div>
          <div className="text-xs sm:text-sm font-extrabold text-slate-900">
            {route.distanceMiles.toFixed(1)} mi
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase text-slate-400 flex items-center gap-0.5">
            <Mountain className="w-3 h-3" /> Elev
          </div>
          <div className="text-xs sm:text-sm font-extrabold text-slate-900">
            {route.elevationGainFt != null ? `+${route.elevationGainFt}ft` : "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase text-indigo-600 flex items-center gap-0.5">
            <Moon className="w-3 h-3" /> Night
          </div>
          <div className="text-xs sm:text-sm font-extrabold text-indigo-700">
            {route.nightScore != null ? `${route.nightScore}` : "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase text-[#FC4C02] flex items-center gap-0.5">
            <Trees className="w-3 h-3" /> View
          </div>
          <div className="text-xs sm:text-sm font-extrabold text-[#FC4C02]">
            {route.sceneryScore}
          </div>
        </div>
      </div>

      {(route.terrainLabel ||
        route.uniquePathPct != null ||
        route.nightLabel ||
        route.trafficLights != null ||
        (route.waterFountains ?? 0) > 0 ||
        (route.restrooms ?? 0) > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 font-medium mb-2">
          {route.terrainLabel && (
            <span>
              Terrain:{" "}
              <span className="font-semibold text-slate-700">
                {route.terrainLabel}
              </span>
              {route.elevationGainFt != null &&
                ` (+${route.elevationGainFt} ft)`}
            </span>
          )}
          {route.nightLabel && (
            <span>
              Lighting:{" "}
              <span className="font-semibold text-slate-700">
                {route.nightLabel}
              </span>
            </span>
          )}
          {route.uniquePathPct != null && (
            <span>
              <span className="font-semibold text-slate-700">
                {route.uniquePathPct}%
              </span>{" "}
              unique roads
            </span>
          )}
          {route.trafficLights != null && (
            <span>
              <span
                className={`font-semibold ${
                  route.trafficLights <= 2
                    ? "text-emerald-700"
                    : "text-slate-700"
                }`}
              >
                {route.trafficLights === 0
                  ? "No lights"
                  : `${route.trafficLights} ${
                      route.trafficLights === 1 ? "light" : "lights"
                    }`}
              </span>
            </span>
          )}
          {(route.waterFountains ?? 0) > 0 && (
            <span title="Drinking water fountains near route">
              💧{" "}
              <span className="font-semibold text-slate-700">
                {route.waterFountains}
              </span>
            </span>
          )}
          {(route.restrooms ?? 0) > 0 && (
            <span title="Public restrooms near route">
              🚻{" "}
              <span className="font-semibold text-slate-700">
                {route.restrooms}
              </span>
            </span>
          )}
        </div>
      )}

      {/* Surface Breakdown Bar */}
      <div className="mb-3">
        <div className="h-1.5 w-full rounded-full overflow-hidden flex bg-slate-100">
          <div
            style={{ width: `${route.surfaceBreakdown.carFreePct}%` }}
            className="bg-emerald-500"
            title={`Trails & car-free paths: ${route.surfaceBreakdown.carFreePct}%`}
          />
          <div
            style={{ width: `${route.surfaceBreakdown.quietStreetPct}%` }}
            className="bg-sky-400"
            title={`Quiet streets & sidewalks: ${route.surfaceBreakdown.quietStreetPct}%`}
          />
          <div
            style={{ width: `${route.surfaceBreakdown.mainRoadPct}%` }}
            className="bg-amber-400"
            title={`Main roads: ${route.surfaceBreakdown.mainRoadPct}%`}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-2 text-[10px] text-slate-500 mt-1">
          <span>🟢 {route.surfaceBreakdown.carFreePct}% Trails/Paths</span>
          <span>🔵 {route.surfaceBreakdown.quietStreetPct}% Streets/Sidewalks</span>
          {route.surfaceBreakdown.mainRoadPct > 0 && (
            <span>🟡 {route.surfaceBreakdown.mainRoadPct}% Main Roads</span>
          )}
        </div>
      </div>

      {/* Highlights */}
      {route.highlights.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {route.highlights.slice(0, 3).map((h, i) => (
            <span
              key={i}
              className="text-[11px] font-medium bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md"
            >
              {h}
            </span>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="space-y-1.5 pt-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onShare(route);
            }}
            className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-[#FC4C02] hover:bg-[#e34402] text-white text-xs font-bold transition shadow-xs cursor-pointer"
          >
            <MessageCircle className="w-3.5 h-3.5" />
            Share
          </button>
          <button
            type="button"
            onClick={handleDownloadGPX}
            className="inline-flex items-center justify-center gap-1 py-2 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition cursor-pointer"
            title="Download GPX for Strava / Watch"
          >
            <Download className="w-3.5 h-3.5" />
            GPX
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <a
            href={buildGoogleMapsWalkingUrl(route)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center gap-1 py-1.5 px-2.5 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200/80 text-slate-700 text-[11px] font-semibold transition"
          >
            <ExternalLink className="w-3 h-3 text-slate-400" />
            Google Maps
          </a>
          <a
            href={buildAppleMapsWalkingUrl(route)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center gap-1 py-1.5 px-2.5 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200/80 text-slate-700 text-[11px] font-semibold transition"
          >
            <ExternalLink className="w-3 h-3 text-slate-400" />
            Apple Maps
          </a>
        </div>
      </div>
    </div>
  );
}
