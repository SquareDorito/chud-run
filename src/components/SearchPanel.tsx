"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  Compass,
  Loader2,
  MapPin,
  Navigation,
  Search,
  Sparkles,
  Utensils,
  X,
} from "lucide-react";
import type { PlaceSuggestion } from "@/lib/types";

interface SavedPlace {
  labelName: string;
  place: PlaceSuggestion;
}

interface SearchPanelProps {
  onSearch: (params: {
    start: PlaceSuggestion;
    minMiles: number | null;
    maxMiles: number | null;
    endQuery: string;
    endPlace: PlaceSuggestion | null;
    preferLoop: boolean;
  }) => void;
  onStartChange?: (start: PlaceSuggestion | null) => void;
  isLoading: boolean;
}

const SAVED_PLACES_KEY = "chudrun_saved_starts_v1";
const SLIDER_MIN = 1;
const SLIDER_MAX = 15;
const SPREAD_MILES = 2;

export default function SearchPanel({
  onSearch,
  onStartChange,
  isLoading,
}: SearchPanelProps) {
  const [startText, setStartText] = useState("");
  const [selectedStart, setSelectedStart] = useState<PlaceSuggestion | null>(
    null
  );
  const [startSuggestions, setStartSuggestions] = useState<PlaceSuggestion[]>(
    []
  );
  const [showStartDropdown, setShowStartDropdown] = useState(false);
  const [locating, setLocating] = useState(false);

  // Saved start labels (e.g. "Home", "Work")
  const [savedStarts, setSavedStarts] = useState<SavedPlace[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(SAVED_PLACES_KEY);
      return raw ? (JSON.parse(raw) as SavedPlace[]) : [];
    } catch {
      return [];
    }
  });
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [saveLabelText, setSaveLabelText] = useState("Home");

  // Fixed 2-mile spread slider (optional)
  const [useDistanceFilter, setUseDistanceFilter] = useState(false);
  const [minMiles, setMinMiles] = useState<number>(3);
  const maxMiles = minMiles + SPREAD_MILES;

  const [endText, setEndText] = useState("");
  const [selectedEnd, setSelectedEnd] = useState<PlaceSuggestion | null>(null);
  const [endSuggestions, setEndSuggestions] = useState<PlaceSuggestion[]>([]);
  const [showEndDropdown, setShowEndDropdown] = useState(false);

  // Route style preference
  const [preferLoop, setPreferLoop] = useState(true);

  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sliderTrackRef = useRef<HTMLDivElement | null>(null);
  const dragModeRef = useRef<"min" | "max" | "center" | null>(null);

  const selectStartPlace = (place: PlaceSuggestion | null) => {
    setSelectedStart(place);
    onStartChange?.(place);
  };

  const isAnyDistance = !useDistanceFilter;

  const updateSliderFromClientX = (
    clientX: number,
    mode: "min" | "max" | "center"
  ) => {
    const track = sliderTrackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const rawMiles = SLIDER_MIN + ratio * (SLIDER_MAX - SLIDER_MIN);
    const snapped = Math.round(rawMiles * 2) / 2;

    let nextMin = minMiles;
    if (mode === "min") {
      nextMin = snapped;
    } else if (mode === "max") {
      nextMin = snapped - SPREAD_MILES;
    } else {
      nextMin = snapped - SPREAD_MILES / 2;
    }

    nextMin = Math.min(
      SLIDER_MAX - SPREAD_MILES,
      Math.max(SLIDER_MIN, Math.round(nextMin * 2) / 2)
    );
    setMinMiles(nextMin);
    setUseDistanceFilter(true);
  };

  const persistSavedStarts = (next: SavedPlace[]) => {
    setSavedStarts(next);
    try {
      localStorage.setItem(SAVED_PLACES_KEY, JSON.stringify(next));
    } catch {
      // ignore storage errors
    }
  };

  const handleSaveStartLabel = () => {
    if (!selectedStart) return;
    const cleanLabel = saveLabelText.trim() || "Home";
    const filtered = savedStarts.filter(
      (s) => s.labelName.toLowerCase() !== cleanLabel.toLowerCase()
    );
    persistSavedStarts([{ labelName: cleanLabel, place: selectedStart }, ...filtered]);
    setShowSaveInput(false);
    setSaveLabelText("Home");
  };

  const handleRemoveSavedStart = (labelName: string) => {
    persistSavedStarts(savedStarts.filter((s) => s.labelName !== labelName));
  };

  // Debounced Start Autocomplete
  useEffect(() => {
    if (startTimer.current) clearTimeout(startTimer.current);
    if (!startText.trim() || selectedStart?.shortName === startText) {
      return;
    }
    startTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/geocode?q=${encodeURIComponent(startText.trim())}`
        );
        const data = (await res.json()) as { places?: PlaceSuggestion[] };
        setStartSuggestions(data.places || []);
        setShowStartDropdown(true);
      } catch {
        // ignore
      }
    }, 320);
    return () => {
      if (startTimer.current) clearTimeout(startTimer.current);
    };
  }, [startText, selectedStart]);

  // Debounced End Autocomplete
  useEffect(() => {
    if (endTimer.current) clearTimeout(endTimer.current);
    if (!endText.trim() || selectedEnd?.shortName === endText) {
      return;
    }
    endTimer.current = setTimeout(async () => {
      try {
        const near = selectedStart
          ? `&nearLat=${selectedStart.lat}&nearLon=${selectedStart.lon}`
          : "";
        const res = await fetch(
          `/api/geocode?q=${encodeURIComponent(endText.trim())}${near}`
        );
        const data = (await res.json()) as { places?: PlaceSuggestion[] };
        setEndSuggestions(data.places || []);
      } catch {
        // ignore
      }
    }, 350);
    return () => {
      if (endTimer.current) clearTimeout(endTimer.current);
    };
  }, [endText, selectedEnd, selectedStart]);

  const handleUseMyLocation = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        try {
          const res = await fetch(
            `/api/geocode?lat=${latitude}&lon=${longitude}`
          );
          const data = (await res.json()) as { places?: PlaceSuggestion[] };
          const place = data.places?.[0] || {
            label: "Current Location",
            shortName: "Current Location",
            lat: latitude,
            lon: longitude,
          };
          selectStartPlace(place);
          setStartText(place.shortName);
          setShowStartDropdown(false);
        } catch {
          const fallback: PlaceSuggestion = {
            label: "Current Location",
            shortName: "Current Location",
            lat: latitude,
            lon: longitude,
          };
          selectStartPlace(fallback);
          setStartText(fallback.shortName);
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 7000 }
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let startToUse = selectedStart;

    if (!startToUse && startText.trim()) {
      try {
        const res = await fetch(
          `/api/geocode?q=${encodeURIComponent(startText.trim())}`
        );
        const data = (await res.json()) as { places?: PlaceSuggestion[] };
        if (data.places?.[0]) {
          startToUse = data.places[0];
          selectStartPlace(startToUse);
          setStartText(startToUse.shortName);
        }
      } catch {
        // ignore
      }
    }

    if (!startToUse) return;

    setShowStartDropdown(false);
    setShowEndDropdown(false);

    onSearch({
      start: startToUse,
      minMiles: isAnyDistance ? null : minMiles,
      maxMiles: isAnyDistance ? null : maxMiles,
      endQuery: endText.trim(),
      endPlace: selectedEnd,
      preferLoop,
    });
  };

  const minPercent = ((minMiles - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100;
  const maxPercent = ((maxMiles - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* 1. START LOCATION (MANDATORY) */}
      <div className="relative">
        <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">
          <span>
            Start Location <span className="text-[#FC4C02]">*</span>
          </span>
          <div className="flex items-center gap-3 normal-case">
            {selectedStart && (
              <button
                type="button"
                onClick={() => setShowSaveInput((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-600 hover:text-[#FC4C02]"
              >
                <Bookmark className="w-3 h-3" />
                Save label
              </button>
            )}
            <button
              type="button"
              onClick={handleUseMyLocation}
              disabled={locating}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#FC4C02] hover:text-[#d94102]"
            >
              {locating ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Navigation className="w-3 h-3" />
              )}
              Use GPS
            </button>
          </div>
        </div>

        <div className="relative flex items-center">
          <MapPin className="w-4 h-4 text-emerald-600 absolute left-3 pointer-events-none" />
          <input
            type="text"
            required
            value={startText}
            onChange={(e) => {
              setStartText(e.target.value);
              selectStartPlace(null);
              setShowSaveInput(false);
            }}
            onFocus={() => {
              if (startSuggestions.length > 0) setShowStartDropdown(true);
            }}
            placeholder="Address, park, or saved label..."
            className="w-full pl-9 pr-8 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-[#FC4C02] focus:ring-2 focus:ring-[#FC4C02]/15 transition"
          />
          {startText && (
            <button
              type="button"
              onClick={() => {
                setStartText("");
                selectStartPlace(null);
                setStartSuggestions([]);
                setShowSaveInput(false);
              }}
              className="absolute right-2.5 text-slate-400 hover:text-slate-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Inline Save Label Prompt */}
        {showSaveInput && selectedStart && (
          <div className="mt-2 flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl p-2">
            <input
              type="text"
              value={saveLabelText}
              onChange={(e) => setSaveLabelText(e.target.value)}
              placeholder="Label (e.g. Home)"
              className="flex-1 text-xs px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 focus:outline-none focus:border-[#FC4C02]"
            />
            <button
              type="button"
              onClick={handleSaveStartLabel}
              className="text-xs font-bold px-3 py-1.5 rounded-lg bg-[#1A1A1E] text-white hover:bg-slate-800"
            >
              Save
            </button>
          </div>
        )}

        {/* Saved Start Labels (e.g. Home, Work) */}
        {savedStarts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {savedStarts.map((item) => {
              const isSelected =
                selectedStart?.lat === item.place.lat &&
                selectedStart?.lon === item.place.lon;
              return (
                <div
                  key={item.labelName}
                  className={`inline-flex items-center gap-1 rounded-full text-[11px] font-semibold pl-2.5 pr-1.5 py-1 transition ${
                    isSelected
                      ? "bg-[#1A1A1E] text-white"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      selectStartPlace(item.place);
                      setStartText(item.place.shortName);
                      setShowStartDropdown(false);
                    }}
                    className="cursor-pointer"
                  >
                    {item.labelName}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveSavedStart(item.labelName)}
                    className="p-0.5 rounded-full hover:bg-black/10 opacity-70 hover:opacity-100"
                    aria-label={`Remove ${item.labelName}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Start Autocomplete Dropdown */}
        {showStartDropdown && startSuggestions.length > 0 && (
          <div className="absolute z-30 left-0 right-0 mt-1 bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden max-h-56 overflow-y-auto">
            {startSuggestions.map((place, idx) => (
              <button
                key={`${place.lat}-${place.lon}-${idx}`}
                type="button"
                onClick={() => {
                  selectStartPlace(place);
                  setStartText(place.shortName);
                  setShowStartDropdown(false);
                }}
                className="w-full text-left px-3.5 py-2.5 hover:bg-orange-50/70 border-b border-slate-100 last:border-b-0 transition"
              >
                <div className="text-xs font-semibold text-slate-900">
                  {place.shortName}
                </div>
                <div className="text-[11px] text-slate-500 truncate">
                  {place.label}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 2. FIXED 2-MILE SPREAD SLIDER (OPTIONAL) */}
      <div>
        <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
          <span className="flex items-center gap-1">
            <Compass className="w-3.5 h-3.5 text-slate-400" />
            Distance
          </span>
          <div className="flex items-center gap-2 normal-case">
            <span className="text-xs font-bold text-slate-900">
              {isAnyDistance
                ? "Any distance"
                : `${minMiles.toFixed(1)} – ${maxMiles.toFixed(1)} mi`}
            </span>
            {!isAnyDistance && (
              <button
                type="button"
                onClick={() => setUseDistanceFilter(false)}
                className="text-[11px] font-semibold text-[#FC4C02] hover:underline"
              >
                Any
              </button>
            )}
          </div>
        </div>

        {/* Dual-thumb slider locked to a fixed 2-mile spread with following value badges */}
        <div
          className="relative pt-6 pb-1 select-none touch-none"
          onPointerMove={(e) => {
            if (!dragModeRef.current) return;
            updateSliderFromClientX(e.clientX, dragModeRef.current);
          }}
          onPointerUp={() => {
            dragModeRef.current = null;
          }}
          onPointerCancel={() => {
            dragModeRef.current = null;
          }}
        >
          {/* Floating badges following each thumb */}
          <div
            className={`absolute top-0 -translate-x-1/2 px-1.5 py-0.5 rounded-md text-[10px] font-bold transition-colors pointer-events-none whitespace-nowrap ${
              useDistanceFilter
                ? "bg-[#1A1A1E] text-white"
                : "bg-slate-200 text-slate-600"
            }`}
            style={{ left: `${minPercent}%` }}
          >
            {minMiles % 1 === 0 ? minMiles.toFixed(0) : minMiles.toFixed(1)} mi
          </div>
          <div
            className={`absolute top-0 -translate-x-1/2 px-1.5 py-0.5 rounded-md text-[10px] font-bold transition-colors pointer-events-none whitespace-nowrap ${
              useDistanceFilter
                ? "bg-[#FC4C02] text-white"
                : "bg-slate-200 text-slate-600"
            }`}
            style={{ left: `${maxPercent}%` }}
          >
            {maxMiles % 1 === 0 ? maxMiles.toFixed(0) : maxMiles.toFixed(1)} mi
          </div>

          <div
            ref={sliderTrackRef}
            onPointerDown={(e) => {
              dragModeRef.current = "center";
              e.currentTarget.setPointerCapture(e.pointerId);
              updateSliderFromClientX(e.clientX, "center");
            }}
            className="relative h-6 flex items-center cursor-pointer"
          >
            <div className="w-full h-1.5 bg-slate-200 rounded-full relative">
              <div
                className={`absolute h-1.5 rounded-full transition-colors ${
                  useDistanceFilter ? "bg-[#FC4C02]" : "bg-slate-300"
                }`}
                style={{
                  left: `${minPercent}%`,
                  right: `${100 - maxPercent}%`,
                }}
              />
            </div>

            {/* Min Thumb */}
            <div
              role="slider"
              tabIndex={0}
              aria-label="Minimum miles"
              aria-valuemin={SLIDER_MIN}
              aria-valuemax={SLIDER_MAX - SPREAD_MILES}
              aria-valuenow={minMiles}
              onPointerDown={(e) => {
                e.stopPropagation();
                dragModeRef.current = "min";
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setMinMiles((m) => Math.min(SLIDER_MAX - SPREAD_MILES, m + 0.5));
                  setUseDistanceFilter(true);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                  e.preventDefault();
                  setMinMiles((m) => Math.max(SLIDER_MIN, m - 0.5));
                  setUseDistanceFilter(true);
                }
              }}
              style={{ left: `${minPercent}%` }}
              className="absolute -translate-x-1/2 w-5 h-5 rounded-full bg-[#FC4C02] border-[2.5px] border-white shadow-md cursor-grab active:cursor-grabbing z-10"
            />

            {/* Max Thumb */}
            <div
              role="slider"
              tabIndex={0}
              aria-label="Maximum miles"
              aria-valuemin={SLIDER_MIN + SPREAD_MILES}
              aria-valuemax={SLIDER_MAX}
              aria-valuenow={maxMiles}
              onPointerDown={(e) => {
                e.stopPropagation();
                dragModeRef.current = "max";
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setMinMiles((m) => Math.min(SLIDER_MAX - SPREAD_MILES, m + 0.5));
                  setUseDistanceFilter(true);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                  e.preventDefault();
                  setMinMiles((m) => Math.max(SLIDER_MIN, m - 0.5));
                  setUseDistanceFilter(true);
                }
              }}
              style={{ left: `${maxPercent}%` }}
              className="absolute -translate-x-1/2 w-5 h-5 rounded-full bg-[#FC4C02] border-[2.5px] border-white shadow-md cursor-grab active:cursor-grabbing z-10"
            />
          </div>
        </div>
        <div className="flex justify-between text-[10px] text-slate-400 font-medium mt-0.5">
          <span>1 mi</span>
          <span>8 mi</span>
          <span>15 mi</span>
        </div>
      </div>

      {/* 3. END DESTINATION / FOOD / AREA (OPTIONAL) */}
      <div className="relative">
        <label className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">
          <Utensils className="w-3.5 h-3.5 text-slate-400" />
          End Destination, Food, or Area{" "}
          <span className="font-normal normal-case text-slate-400">
            (optional)
          </span>
        </label>

        <div className="relative flex items-center">
          <Search className="w-4 h-4 text-[#FC4C02] absolute left-3 pointer-events-none" />
          <input
            type="text"
            value={endText}
            onChange={(e) => {
              setEndText(e.target.value);
              setSelectedEnd(null);
              setShowEndDropdown(true);
            }}
            onFocus={() => {
              if (endSuggestions.length > 0) setShowEndDropdown(true);
            }}
            placeholder="Address, neighborhood, or food (e.g. tacos, coffee)..."
            className="w-full pl-9 pr-8 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-[#FC4C02] focus:ring-2 focus:ring-[#FC4C02]/15 transition"
          />
          {endText && (
            <button
              type="button"
              onClick={() => {
                setEndText("");
                setSelectedEnd(null);
                setEndSuggestions([]);
              }}
              className="absolute right-2.5 text-slate-400 hover:text-slate-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* End Autocomplete Dropdown */}
        {showEndDropdown && endSuggestions.length > 0 && endText.trim().length > 2 && (
          <div className="absolute z-30 left-0 right-0 mt-1 bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden max-h-48 overflow-y-auto">
            {endSuggestions.map((place, idx) => (
              <button
                key={`${place.lat}-${place.lon}-${idx}`}
                type="button"
                onClick={() => {
                  setSelectedEnd(place);
                  setEndText(place.shortName);
                  setShowEndDropdown(false);
                }}
                className="w-full text-left px-3.5 py-2 hover:bg-orange-50/70 border-b border-slate-100 last:border-b-0 transition"
              >
                <div className="text-xs font-semibold text-slate-900">
                  {place.shortName}
                </div>
                <div className="text-[11px] text-slate-500 truncate">
                  {place.label}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 4. ROUTE SHAPE (SINGLE CLEAN TOGGLE) */}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
          Route Style
        </span>
        <div className="inline-flex rounded-xl bg-slate-100 p-0.5 text-[11px] font-semibold">
          <button
            type="button"
            onClick={() => setPreferLoop(true)}
            className={`px-2.5 py-1 rounded-lg transition ${
              preferLoop
                ? "bg-white text-slate-900 shadow-xs"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            Loop (unique roads)
          </button>
          <button
            type="button"
            onClick={() => setPreferLoop(false)}
            className={`px-2.5 py-1 rounded-lg transition ${
              !preferLoop
                ? "bg-white text-slate-900 shadow-xs"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            There &amp; Back
          </button>
        </div>
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={isLoading || !startText.trim()}
        className="w-full py-3 px-4 rounded-xl bg-[#FC4C02] hover:bg-[#e34402] disabled:bg-slate-300 text-white font-bold text-sm flex items-center justify-center gap-2 transition shadow-sm cursor-pointer disabled:cursor-not-allowed"
      >
        {isLoading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Finding Traffic-Free Scenic Paths...
          </>
        ) : (
          <>
            <Sparkles className="w-4 h-4" />
            Find Scenic Routes
          </>
        )}
      </button>
    </form>
  );
}
