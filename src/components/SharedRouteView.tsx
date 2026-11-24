"use client";

import { useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowLeft, Download, MessageCircle, Moon, Mountain, Trees } from "lucide-react";
import { generateGPX } from "@/lib/share";
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

  return (
    <div className="h-screen w-screen flex flex-col lg:flex-row bg-[#F7F7FA] overflow-hidden">
      {/* Sidebar / Bottom Card */}
      <aside className="order-2 lg:order-1 w-full lg:w-[420px] bg-white border-t lg:border-t-0 lg:border-r border-slate-200 p-5 flex flex-col justify-between overflow-y-auto z-10 max-h-[52vh] lg:max-h-full">
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

          <span className="inline-block text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-orange-50 text-[#FC4C02] mb-2">
            {route.mode === "loop" ? "Scenic Loop" : "Point-to-Point Run"}
          </span>

          <h1 className="text-2xl font-extrabold text-slate-900 leading-tight">
            {route.name}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {route.start.shortName}
            {route.mode === "point-to-point"
              ? ` → ${route.end.shortName}`
              : ""}
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 gap-3 my-5">
            <div className="bg-slate-50 rounded-2xl p-3 border border-slate-100">
              <div className="text-[11px] font-semibold text-slate-400 uppercase">
                Distance
              </div>
              <div className="text-xl font-extrabold text-slate-900">
                {route.distanceMiles.toFixed(1)} mi
              </div>
            </div>
            {route.elevationGainFt != null && (
              <div className="bg-slate-50 rounded-2xl p-3 border border-slate-100">
                <div className="text-[11px] font-semibold text-slate-400 uppercase flex items-center gap-1">
                  <Mountain className="w-3.5 h-3.5" /> Elevation
                </div>
                <div className="text-xl font-extrabold text-slate-900">
                  +{route.elevationGainFt} ft
                  {route.terrainLabel ? (
                    <span className="text-xs font-semibold text-slate-500 ml-1.5">
                      ({route.terrainLabel})
                    </span>
                  ) : null}
                </div>
              </div>
            )}
            {route.nightScore != null && (
              <div className="bg-indigo-50 rounded-2xl p-3 border border-indigo-100">
                <div className="text-[11px] font-semibold text-indigo-700 uppercase flex items-center gap-1">
                  <Moon className="w-3.5 h-3.5" /> Night Lighting
                </div>
                <div className="text-xl font-extrabold text-indigo-900">
                  {route.nightScore}/100
                  {route.nightLabel ? (
                    <span className="text-xs font-semibold text-indigo-600 ml-1.5">
                      ({route.nightLabel})
                    </span>
                  ) : null}
                </div>
              </div>
            )}
            <div className="bg-orange-50 rounded-2xl p-3 border border-orange-100">
              <div className="text-[11px] font-semibold text-[#FC4C02] uppercase flex items-center gap-1">
                <Trees className="w-3.5 h-3.5" /> Scenery
              </div>
              <div className="text-xl font-extrabold text-[#FC4C02]">
                {route.sceneryScore}/100
              </div>
            </div>
          </div>

          {route.highlights.length > 0 && (
            <div className="mb-5">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
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

        <div className="flex items-center gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={() => setShowShare(true)}
            className="flex-1 inline-flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-[#FC4C02] hover:bg-[#e34402] text-white font-bold text-sm transition"
          >
            <MessageCircle className="w-4 h-4" />
            Share
          </button>
          <button
            type="button"
            onClick={handleDownloadGPX}
            className="inline-flex items-center justify-center gap-1.5 py-3 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-sm transition"
          >
            <Download className="w-4 h-4" />
            GPX
          </button>
        </div>
      </aside>

      {/* Map */}
      <div className="order-1 lg:order-2 flex-1 relative min-h-[45vh]">
        <RouteMap
          routes={[route]}
          activeRouteId={route.id}
          center={[route.start.lat, route.start.lon]}
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
