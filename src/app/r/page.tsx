import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { decodeRouteFromToken } from "@/lib/share";
import SharedRouteView from "@/components/SharedRouteView";

type Props = {
  searchParams: Promise<{ d?: string }>;
};

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { d } = await searchParams;
  const route = d ? decodeRouteFromToken(d) : null;

  if (!route) {
    return {
      title: "Shared Running Route | ChudRun",
      description: "Discover traffic-free, scenic running routes on ChudRun.",
    };
  }

  const title = `${route.name} · ${route.distanceMiles.toFixed(1)} mi (${route.trafficFreePct}% Traffic-Free)`;
  const description =
    route.mode === "point-to-point"
      ? `Scenic run from ${route.start.shortName} to ${route.end.shortName} · ${route.highlights.slice(0, 2).join(", ")}`
      : `Scenic ${route.distanceMiles.toFixed(1)} mi loop starting at ${route.start.shortName} · ${route.highlights.slice(0, 2).join(", ")}`;

  const ogUrl = `/api/og?d=${encodeURIComponent(d!)}`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      images: [
        {
          url: ogUrl,
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogUrl],
    },
  };
}

async function SharedRouteContent({
  searchParams,
}: {
  searchParams: Promise<{ d?: string }>;
}) {
  const { d } = await searchParams;
  const route = d ? decodeRouteFromToken(d) : null;

  if (!route) {
    return (
      <main className="min-h-screen bg-[#F7F7FA] flex flex-col items-center justify-center p-6 text-center">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 max-w-md w-full">
          <div className="w-12 h-12 rounded-xl bg-[#FC4C02] text-white font-extrabold text-2xl flex items-center justify-center mx-auto mb-4">
            C
          </div>
          <h1 className="text-xl font-bold text-slate-900 mb-2">
            Route Link Not Found
          </h1>
          <p className="text-sm text-slate-500 mb-6">
            This shared running route link is invalid or incomplete.
          </p>
          <Link
            href="/"
            className="inline-flex items-center justify-center w-full py-3 px-4 rounded-xl bg-[#FC4C02] text-white font-semibold hover:bg-[#e04300] transition"
          >
            Plan a New Run
          </Link>
        </div>
      </main>
    );
  }

  return <SharedRouteView route={route} token={d!} />;
}

export default function SharedRoutePage({ searchParams }: Props) {
  return (
    <Suspense
      fallback={
        <div className="h-screen w-screen flex items-center justify-center bg-[#F7F7FA] text-sm text-slate-500">
          Loading shared route...
        </div>
      }
    >
      <SharedRouteContent searchParams={searchParams} />
    </Suspense>
  );
}
