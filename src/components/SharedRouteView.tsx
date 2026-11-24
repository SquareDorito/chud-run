"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  ArrowLeft,
  Clock,
  Download,
  ExternalLink,
  MapPin,
  MessageCircle,
  Moon,
  Mountain,
  Navigation,
  Repeat,
  ShieldCheck,
  Trees,
} from "lucide-react";
import {
  buildAppleMapsWalkingUrl,
  buildGoogleMapsWalkingUrl,
  generateGPX,
} from "@/lib/share";
import ShareModal from "./ShareModal";
import type { RunRoute } from "@/lib/types";

const RouteMap = dynamic(() => import("./RouteMap"), { ssr: false });

export default function SharedRouteView({
  route,
  shareId,
}: {
  route: RunRoute;
  token?: string;
  shareId?: string;
}) {
  const [showShare, setShowShare] = useState(false);

  const mapRoutes = useMemo(() => [route], [route]);
  const mapCenter = useMemo<[number, number]>(
    () => [route.start.lat, route.start.lon],
    [route.start.lat, route.start.lon]
  );
  const googleMapsUrl = useMemo(
    () => buildGoogleMapsWalkingUrl(route),
    [route]
  );
  const appleMapsUrl = useMemo(() => buildAppleMapsWalkingUrl(route), [route]);

  const handleDownloadGPX = () => {
    const gpx = generateGPX(route);
    const blob = new Blob([gpx], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${route.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.gpx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const hasExtraDetails =
    route.uniquePathPct != null ||
    route.trafficLights != null ||
    (route.waterFountains ?? 0) > 0 ||
    (route.restrooms ?? 0) > 0;

  return (
    <div className="h-screen w-screen flex flex-col lg:flex-row bg-[#F7F7FA] overflow-hidden">
      {/* Sidebar / Bottom Card */}
      <aside className="order-2 lg:order-1 w-full lg:w-[440px] bg-white border-t lg:border-t-0 lg:border-r border-slate-200 p-5 flex flex-col justify-between overflow-y-auto z-10 max-h-[55vh] lg:max-h-full">
        <div>
          <div className="flex items-center justify-between mb-4">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900"
            >
              <ArrowLeft className="w-4 h-4" />
              Plan Your Own Run
            </Link>
            <div className="flex items-center gap-1.5">
              <div className="w-6 h-6 rounded-md bg-[#FC4C02] text-white font-extrabold text-xs flex items-center justify-center">
                C
              </div>
              <span className="font-extrabold text-sm text-slate-900">
                ChudRun
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            <span
              className={`inline-block text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full ${
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
                : "Point-to-Point Run"}
            </span>
            {route.lapInfo && (
              <span className="inline-block text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
                {route.lapInfo.laps}{" "}
                {route.lapInfo.kind === "track" ? "Track" : "Park"}{" "}
                {route.lapInfo.laps === 1 ? "Lap" : "Laps"}
              </span>
            )}
          </div>

          <h1 className="text-2xl font-extrabold text-slate-900 leading-tight">
            {route.name}
          </h1>
          {route.tagline && (
            <p className="text-xs text-slate-500 mt-1">{route.tagline}</p>
          )}

          {/* Start & End Location Card */}
          <div className="mt-4 bg-slate-50 rounded-2xl p-3.5 border border-slate-100 space-y-2.5">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 w-5 h-5 rounded-full bg-emerald-500 text-white text-[10px] font-extrabold flex items-center justify-center shrink-0">
                S
              </span>
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  Start
                </div>
                <div className="text-xs font-bold text-slate-900 leading-snug">
                  {route.start.shortName}
                </div>
                {route.start.label &&
                  route.start.label !== route.start.shortName && (
                    <div className="text-[11px] text-slate-500 line-clamp-1">
                      {route.start.label}
                    </div>
                  )}
              </div>
            </div>

            <div className="flex items-start gap-2.5 pt-2 border-t border-slate-200/70">
              {route.mode === "loop" ? (
                <span className="mt-0.5 w-5 h-5 rounded-full bg-orange-100 text-[#FC4C02] flex items-center justify-center shrink-0">
                  <Repeat className="w-3 h-3" />
                </span>
              ) : (
                <span className="mt-0.5 w-5 h-5 rounded-full bg-[#FC4C02] text-white text-[10px] font-extrabold flex items-center justify-center shrink-0">
                  E
                </span>
              )}
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  {route.mode === "loop"
                    ? "Finish (Loop)"
                    : route.destinationFoodOrArea
                    ? `Destination · ${route.destinationFoodOrArea}`
                    : "Finish"}
                </div>
                <div className="text-xs font-bold text-slate-900 leading-snug flex flex-wrap items-center gap-1.5">
                  <span>
                    {route.mode === "loop"
                      ? `Returns to ${route.start.shortName}`
                      : route.end.shortName}
                  </span>
                  {route.mode === "point-to-point" &&
                    route.end.rating != null && (
                      <span className="text-[11px] font-semibold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-md">
                        ★ {route.end.rating.toFixed(1)}
                        {route.end.ratingCount
                          ? ` (${route.end.ratingCount})`
                          : ""}
                      </span>
                    )}
                </div>
                {route.mode === "point-to-point" &&
                  route.end.label &&
                  route.end.label !== route.end.shortName && (
                    <div className="text-[11px] text-slate-500 line-clamp-1">
                      {route.end.label}
                    </div>
                  )}
              </div>
            </div>
          </div>

          {/* Primary Stats Grid */}
          <div className="grid grid-cols-3 gap-2.5 my-4">
            <div className="bg-slate-50 rounded-2xl p-3 border border-slate-100">
              <div className="text-[10px] font-semibold text-slate-400 uppercase">
                Distance
              </div>
              <div className="text-lg font-extrabold text-slate-900">
                {route.distanceMiles.toFixed(1)} mi
              </div>
            </div>

            <div className="bg-slate-50 rounded-2xl p-3 border border-slate-100">
              <div className="text-[10px] font-semibold text-slate-400 uppercase flex items-center gap-1">
                <Clock className="w-3 h-3" /> Est. Time
              </div>
              <div className="text-lg font-extrabold text-slate-900">
                ~{route.estimatedMinutes}m
              </div>
            </div>

            <div className="bg-emerald-50 rounded-2xl p-3 border border-emerald-100">
              <div className="text-[10px] font-semibold text-emerald-700 uppercase flex items-center gap-1">
                <ShieldCheck className="w-3 h-3" /> Calm
              </div>
              <div className="text-lg font-extrabold text-emerald-800">
                {route.trafficFreePct}%
              </div>
            </div>

            {route.elevationGainFt != null && (
              <div className="bg-slate-50 rounded-2xl p-3 border border-slate-100">
                <div className="text-[10px] font-semibold text-slate-400 uppercase flex items-center gap-1">
                  <Mountain className="w-3 h-3" /> Elevation
                </div>
                <div className="text-base font-extrabold text-slate-900 leading-tight">
                  +{route.elevationGainFt} ft
                </div>
                {route.terrainLabel && (
                  <div className="text-[11px] font-medium text-slate-500">
                    {route.terrainLabel}
                  </div>
                )}
              </div>
            )}

            {route.nightScore != null && (
              <div className="bg-indigo-50 rounded-2xl p-3 border border-indigo-100">
                <div className="text-[10px] font-semibold text-indigo-700 uppercase flex items-center gap-1">
                  <Moon className="w-3 h-3" /> Night
                </div>
                <div className="text-base font-extrabold text-indigo-900 leading-tight">
                  {route.nightScore}/100
                </div>
                {route.nightLabel && (
                  <div className="text-[11px] font-medium text-indigo-600">
                    {route.nightLabel}
                  </div>
                )}
              </div>
            )}

            <div className="bg-orange-50 rounded-2xl p-3 border border-orange-100">
              <div className="text-[10px] font-semibold text-[#FC4C02] uppercase flex items-center gap-1">
                <Trees className="w-3 h-3" /> Scenery
              </div>
              <div className="text-base font-extrabold text-[#FC4C02] leading-tight">
                {route.sceneryScore}/100
              </div>
            </div>
          </div>

          {/* Extra Route Details Strip */}
          {hasExtraDetails && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-slate-600 font-medium mb-4">
              {route.uniquePathPct != null && (
                <span>
                  <span className="font-bold text-slate-800">
                    {route.uniquePathPct}%
                  </span>{" "}
                  unique roads
                </span>
              )}
              {route.trafficLights != null && (
                <span
                  className={`font-semibold ${
                    route.trafficLights <= 2
                      ? "text-emerald-700"
                      : "text-slate-700"
                  }`}
                >
                  {route.trafficLights === 0
                    ? "No traffic lights"
                    : `${route.trafficLights} traffic ${
                        route.trafficLights === 1 ? "light" : "lights"
                      }`}
                </span>
              )}
              {(route.waterFountains ?? 0) > 0 && (
                <span>
                  💧{" "}
                  <span className="font-bold text-slate-800">
                    {route.waterFountains}
                  </span>{" "}
                  water
                </span>
              )}
              {(route.restrooms ?? 0) > 0 && (
                <span>
                  🚻{" "}
                  <span className="font-bold text-slate-800">
                    {route.restrooms}
                  </span>{" "}
                  restrooms
                </span>
              )}
            </div>
          )}

          {/* Surface Breakdown Bar */}
          <div className="mb-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
              Surface Breakdown
            </div>
            <div className="h-2 w-full rounded-full overflow-hidden flex bg-slate-100">
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
            <div className="flex flex-wrap items-center justify-between gap-x-2 text-[11px] text-slate-500 mt-1.5">
              <span>🟢 {route.surfaceBreakdown.carFreePct}% Trails/Paths</span>
              <span>
                🔵 {route.surfaceBreakdown.quietStreetPct}% Streets/Sidewalks
              </span>
              {route.surfaceBreakdown.mainRoadPct > 0 && (
                <span>🟡 {route.surfaceBreakdown.mainRoadPct}% Main Roads</span>
              )}
            </div>
          </div>

          {/* Highlights */}
          {route.highlights.length > 0 && (
            <div className="mb-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                Route Highlights
              </div>
              <div className="flex flex-wrap gap-1.5">
                {route.highlights.map((h, i) => (
                  <span
                    key={i}
                    className="text-xs font-medium bg-slate-100 text-slate-700 px-2.5 py-1 rounded-lg"
                  >
                    {h}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Bottom Actions: Open in Maps + Share / GPX */}
        <div className="space-y-2 pt-3 border-t border-slate-100">
          <div className="grid grid-cols-2 gap-2">
            <a
              href={googleMapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs transition"
            >
              <Navigation className="w-3.5 h-3.5" />
              Google Maps
              <ExternalLink className="w-3 h-3 opacity-60" />
            </a>
            <a
              href={appleMapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold text-xs transition"
            >
              <MapPin className="w-3.5 h-3.5 text-[#FC4C02]" />
              Apple Maps
              <ExternalLink className="w-3 h-3 opacity-50" />
            </a>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowShare(true)}
              className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-[#FC4C02] hover:bg-[#e34402] text-white font-bold text-sm transition"
            >
              <MessageCircle className="w-4 h-4" />
              Share
            </button>
            <button
              type="button"
              onClick={handleDownloadGPX}
              className="inline-flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-sm transition"
            >
              <Download className="w-4 h-4" />
              GPX
            </button>
          </div>
        </div>
      </aside>

      {/* Map */}
      <div className="order-1 lg:order-2 flex-1 relative min-h-[45vh]">
        <RouteMap
          routes={mapRoutes}
          activeRouteId={route.id}
          center={mapCenter}
        />
      </div>

      {showShare && (
        <ShareModal
          route={route}
          initialShareId={shareId}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}
