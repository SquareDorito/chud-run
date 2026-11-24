"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronDown, ChevronUp, ShieldCheck } from "lucide-react";
import SearchPanel from "@/components/SearchPanel";
import RouteCard from "@/components/RouteCard";
import ShareModal from "@/components/ShareModal";
import type {
  ElevationPreference,
  PlaceSuggestion,
  RouteSearchResponse,
  RunRoute,
} from "@/lib/types";

const RouteMap = dynamic(() => import("@/components/RouteMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-slate-100 flex items-center justify-center text-sm text-slate-400">
      Loading map...
    </div>
  ),
});

export default function HomePage() {
  const [routes, setRoutes] = useState<RunRoute[]>([]);
  const [visibleCount, setVisibleCount] = useState(3);
  const [activeRouteId, setActiveRouteId] = useState<string | null>(null);
  const [selectedStart, setSelectedStart] = useState<PlaceSuggestion | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [shareRoute, setShareRoute] = useState<RunRoute | null>(null);
  const [mobileSheetExpanded, setMobileSheetExpanded] = useState(true);
  const searchAbortRef = useRef<AbortController | null>(null);

  const handleSearch = async (params: {
    start: PlaceSuggestion;
    minMiles: number | null;
    maxMiles: number | null;
    endQuery: string;
    endPlace: PlaceSuggestion | null;
    preferLoop: boolean;
    elevationPref: ElevationPreference;
  }) => {
    // Cancel any previous in-flight route search so stale responses never overwrite newer ones
    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
    }
    const controller = new AbortController();
    searchAbortRef.current = controller;

    setIsLoading(true);
    setError(null);
    setNote(null);

    try {
      const res = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });

      const data = (await res.json()) as RouteSearchResponse & {
        error?: string;
      };
      if (controller.signal.aborted) return;

      if (!res.ok || data.error) {
        setError(data.error || "Could not find routes for this location.");
        return;
      }

      if (!data.routes || data.routes.length === 0) {
        setError("No walkable/running paths found nearby. Try another start!");
        return;
      }

      setRoutes(data.routes);
      setVisibleCount(3);
      setActiveRouteId(data.routes[0].id);
      if (data.note) setNote(data.note);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (controller.signal.aborted) return;
      setError("Network error while finding routes. Please try again.");
    } finally {
      if (searchAbortRef.current === controller) {
        setIsLoading(false);
      }
    }
  };

  const visibleRoutes = routes.slice(0, visibleCount);
  const remainingCount = routes.length - visibleRoutes.length;

  return (
    <div className="h-screen w-screen flex flex-col lg:flex-row bg-[#F7F7FA] overflow-hidden">
      {/* Desktop Sidebar / Mobile Bottom Sheet */}
      <aside
        className={`order-2 lg:order-1 w-full lg:w-[430px] bg-white border-t lg:border-t-0 lg:border-r border-slate-200 flex flex-col z-20 transition-all duration-200 ${
          mobileSheetExpanded ? "max-h-[64vh] lg:max-h-full" : "max-h-[76px] lg:max-h-full"
        }`}
      >
        {/* Top Brand Header */}
        <header className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#FC4C02] text-white font-black text-lg flex items-center justify-center shadow-xs">
              C
            </div>
            <div>
              <h1 className="font-extrabold text-slate-900 text-base leading-none tracking-tight">
                ChudRun
              </h1>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Traffic-free &amp; scenic running routes
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMobileSheetExpanded((v) => !v)}
              className="lg:hidden p-1.5 rounded-lg bg-slate-100 text-slate-600"
              aria-label="Toggle panel"
            >
              {mobileSheetExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronUp className="w-4 h-4" />
              )}
            </button>
          </div>
        </header>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <SearchPanel
            onSearch={handleSearch}
            onStartChange={(start) => {
              setSelectedStart(start);
              if (!start) setRoutes([]);
            }}
            isLoading={isLoading}
          />

          {error && (
            <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs font-medium text-red-700">
              {error}
            </div>
          )}

          {note && (
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs font-medium text-amber-800">
              {note}
            </div>
          )}

          {/* Results */}
          {visibleRoutes.length > 0 ? (
            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Showing {visibleRoutes.length} of {routes.length} Routes
                </h2>
                <span className="text-[11px] text-emerald-700 font-semibold flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" /> Sorted by Best Match
                </span>
              </div>

              {visibleRoutes.map((route) => (
                <RouteCard
                  key={route.id}
                  route={route}
                  isActive={route.id === activeRouteId}
                  onSelect={() => setActiveRouteId(route.id)}
                  onShare={(r) => setShareRoute(r)}
                />
              ))}

              {remainingCount > 0 && (
                <button
                  type="button"
                  onClick={() => setVisibleCount((c) => c + 3)}
                  className="w-full py-2.5 px-4 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs font-bold text-slate-700 transition cursor-pointer"
                >
                  Show {Math.min(3, remainingCount)} more route
                  {Math.min(3, remainingCount) === 1 ? "" : "s"}
                </button>
              )}
            </div>
          ) : (
            !isLoading && (
              <div className="rounded-2xl bg-slate-50 border border-slate-200/80 p-4 text-xs text-slate-600 space-y-2">
                <div className="font-bold text-slate-800">
                  How ChudRun picks your route:
                </div>
                <ul className="space-y-1 text-slate-500 list-disc pl-4">
                  <li>
                    Only <strong>Start Location</strong> is required — leave the rest blank for a scenic ~3.5 mi loop.
                  </li>
                  <li>
                    Prioritizes <strong>car-free greenways, park paths, &amp; waterfronts</strong> over busy roads.
                  </li>
                  <li>
                    Type a food craving like <strong>&ldquo;tacos&rdquo;</strong> or <strong>&ldquo;coffee&rdquo;</strong> to finish your run with a reward.
                  </li>
                  <li>
                    <strong>Share</strong> any route with a live map preview card.
                  </li>
                </ul>
              </div>
            )
          )}
        </div>
      </aside>

      {/* Interactive Map */}
      <main className="order-1 lg:order-2 flex-1 relative min-h-[36vh]">
        <RouteMap
          routes={visibleRoutes}
          activeRouteId={activeRouteId}
          startLocation={selectedStart}
          onSelectRoute={(id) => setActiveRouteId(id)}
        />
      </main>

      {shareRoute && (
        <ShareModal route={shareRoute} onClose={() => setShareRoute(null)} />
      )}
    </div>
  );
}
