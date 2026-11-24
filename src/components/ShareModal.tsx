"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  MapPin,
  MessageCircle,
  Navigation,
  Share2,
  X,
} from "lucide-react";
import {
  buildAppleMapsWalkingUrl,
  buildGoogleMapsWalkingUrl,
  encodeRouteToToken,
} from "@/lib/share";
import type { RunRoute } from "@/lib/types";

interface ShareModalProps {
  route: RunRoute;
  initialShareId?: string;
  onClose: () => void;
}

export default function ShareModal({
  route,
  initialShareId,
  onClose,
}: ShareModalProps) {
  const [copied, setCopied] = useState(false);
  const [createdShareId, setCreatedShareId] = useState<string | null>(null);
  const [shareSettled, setShareSettled] = useState(Boolean(initialShareId));

  const shareId = initialShareId ?? createdShareId;
  const creatingLink = !initialShareId && !shareSettled;

  useEffect(() => {
    if (initialShareId) return;

    const controller = new AbortController();

    fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route }),
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { id?: string } | null) => {
        if (!controller.signal.aborted && data?.id) {
          setCreatedShareId(data.id);
        }
      })
      .catch(() => {
        // Ignore abort / network errors; fallback token URL remains available
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setShareSettled(true);
        }
      });

    return () => controller.abort();
  }, [route, initialShareId]);

  const {
    shareUrl,
    ogImageUrl,
    smsHref,
    shareText,
    googleMapsUrl,
    appleMapsUrl,
  } = useMemo(() => {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    const fallbackToken = shareId ? null : encodeRouteToToken(route);
    const url = shareId
      ? `${origin}/r/${shareId}`
      : `${origin}/r?d=${encodeURIComponent(fallbackToken!)}`;
    const og = shareId
      ? `/api/og?id=${encodeURIComponent(shareId)}`
      : `/api/og?d=${encodeURIComponent(fallbackToken!)}`;
    const text = `Let's run "${route.name}" — ${route.distanceMiles.toFixed(1)} mi (${route.trafficFreePct}% traffic-free)!`;
    // Send the standalone short URL in Messages so iMessage renders a rich
    // full-bleed link preview bubble with the route map & stats card.
    const sms = `sms:&body=${encodeURIComponent(url)}`;
    return {
      shareUrl: url,
      ogImageUrl: og,
      smsHref: sms,
      shareText: text,
      googleMapsUrl: buildGoogleMapsWalkingUrl(route),
      appleMapsUrl: buildAppleMapsWalkingUrl(route),
    };
  }, [route, shareId]);

  const handleCopy = async () => {
    if (creatingLink) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // ignore
    }
  };

  const handleNativeShare = async () => {
    if (creatingLink) return;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({
          title: `${route.name} · ${route.distanceMiles.toFixed(1)} mi`,
          text: shareText,
          url: shareUrl,
        });
      } catch {
        // user cancelled
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[1000] bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl shadow-2xl p-5 sm:p-6 animate-in fade-in slide-in-from-bottom-4 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3.5">
          <div>
            <h2 className="text-lg font-extrabold text-slate-900">
              Route Overview &amp; Share
            </h2>
            <p className="text-xs text-slate-500">
              Open for turn-by-turn navigation or share a link preview
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-full hover:bg-slate-100 text-slate-500"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Route Overview Card */}
        <div className="bg-slate-100 rounded-2xl p-2.5 mb-4">
          <div className="bg-white rounded-xl overflow-hidden shadow-xs border border-slate-200">
            {creatingLink ? (
              <div className="w-full aspect-[1200/630] bg-slate-900 flex items-center justify-center text-slate-400 text-xs gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating route preview...
              </div>
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={ogImageUrl}
                alt={route.name}
                className="w-full aspect-[1200/630] object-cover bg-slate-900"
              />
            )}
            <div className="p-3">
              <div className="text-xs font-bold text-slate-900 line-clamp-1">
                {route.name} · {route.distanceMiles.toFixed(1)} mi
                {route.elevationGainFt != null
                  ? ` · +${route.elevationGainFt} ft`
                  : ""}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap items-center gap-x-2">
                <span>{route.surfaceBreakdown.carFreePct}% trails/paths</span>
                {route.nightScore != null && (
                  <span>· Night {route.nightScore}</span>
                )}
                <span>· View {route.sceneryScore}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Open in Maps */}
        <div className="mb-4">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
            Open in Maps
          </div>
          <div className="grid grid-cols-2 gap-2.5">
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
        </div>

        {/* Share Actions */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Share Route
            </div>
            {shareId && (
              <span className="text-[11px] font-mono text-slate-400">
                /r/{shareId}
              </span>
            )}
          </div>
          <a
            href={creatingLink ? undefined : smsHref}
            aria-disabled={creatingLink}
            onClick={(e) => {
              if (creatingLink) e.preventDefault();
            }}
            className={`w-full inline-flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-[#34C759] hover:bg-[#2db84e] text-white font-bold text-sm transition shadow-xs ${
              creatingLink ? "opacity-60 pointer-events-none" : ""
            }`}
          >
            {creatingLink ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating Short Link...
              </>
            ) : (
              <>
                <MessageCircle className="w-4 h-4" />
                Send via Messages
              </>
            )}
          </a>

          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={handleCopy}
              disabled={creatingLink}
              className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 disabled:opacity-60 text-slate-800 font-semibold text-xs transition"
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4 text-emerald-600" />
                  Copied Link!
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  Copy Link
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleNativeShare}
              disabled={creatingLink}
              className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-[#FC4C02] hover:bg-[#e34402] disabled:opacity-60 text-white font-semibold text-xs transition"
            >
              <Share2 className="w-4 h-4" />
              Share Sheet
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
