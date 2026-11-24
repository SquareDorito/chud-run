import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { decodeRouteFromToken } from "@/lib/share";
import { getSharedRouteById } from "@/lib/share-store";

function projectCoordsToSvg(
  coords: [number, number][],
  width: number,
  height: number,
  pad = 44
): { points: string; startPt: [number, number]; endPt: [number, number] } {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const [lat, lon] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  const latSpan = Math.max(0.002, maxLat - minLat);
  const lonSpan = Math.max(0.002, maxLon - minLon);
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const scale = Math.min(innerW / lonSpan, innerH / latSpan);
  const offsetX = (width - lonSpan * scale) / 2;
  const offsetY = (height - latSpan * scale) / 2;

  const projected: [number, number][] = coords.map(([lat, lon]) => {
    const x = offsetX + (lon - minLon) * scale;
    const y = height - (offsetY + (lat - minLat) * scale);
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });

  return {
    points: projected.map(([x, y]) => `${x},${y}`).join(" "),
    startPt: projected[0],
    endPt: projected[projected.length - 1],
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const token = searchParams.get("d");
  const route = id
    ? await getSharedRouteById(id)
    : token
      ? decodeRouteFromToken(token)
      : null;

  if (!route) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: "#14161B",
            color: "#FFFFFF",
            fontFamily: "sans-serif",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "14px",
              marginBottom: "20px",
            }}
          >
            <div
              style={{
                width: "44px",
                height: "44px",
                borderRadius: "12px",
                backgroundColor: "#FC4C02",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "26px",
                fontWeight: 800,
              }}
            >
              C
            </div>
            <div style={{ fontSize: "40px", fontWeight: 800, letterSpacing: "-0.02em" }}>
              ChudRun
            </div>
          </div>
          <div style={{ fontSize: "26px", color: "#94A3B8" }}>
            Scenic, Traffic-Free Running Routes
          </div>
        </div>
      ),
      { width: 1200, height: 630 }
    );
  }

  const svgW = 500;
  const svgH = 540;
  const { points, startPt, endPt } = projectCoordsToSvg(
    route.coordinates,
    svgW,
    svgH,
    56
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "row",
          backgroundColor: "#FFFFFF",
          fontFamily: "sans-serif",
        }}
      >
        {/* Left: Dark Topographic Route Preview */}
        <div
          style={{
            width: "520px",
            height: "630px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#14161B",
            position: "relative",
            padding: "24px",
          }}
        >
          <svg
            width={svgW}
            height={svgH}
            viewBox={`0 0 ${svgW} ${svgH}`}
            style={{ display: "flex" }}
          >
            {/* Subtle Map Grid */}
            <line x1="0" y1="135" x2={svgW} y2="135" stroke="#222630" strokeWidth="1" />
            <line x1="0" y1="270" x2={svgW} y2="270" stroke="#222630" strokeWidth="1" />
            <line x1="0" y1="405" x2={svgW} y2="405" stroke="#222630" strokeWidth="1" />
            <line x1="125" y1="0" x2="125" y2={svgH} stroke="#222630" strokeWidth="1" />
            <line x1="250" y1="0" x2="250" y2={svgH} stroke="#222630" strokeWidth="1" />
            <line x1="375" y1="0" x2="375" y2={svgH} stroke="#222630" strokeWidth="1" />

            {/* Route Outer Glow */}
            <polyline
              fill="none"
              stroke="rgba(252, 76, 2, 0.28)"
              strokeWidth="16"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={points}
            />
            {/* Route Main Line */}
            <polyline
              fill="none"
              stroke="#FC4C02"
              strokeWidth="7"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={points}
            />
            {/* End Marker */}
            {route.mode === "point-to-point" && (
              <circle
                cx={endPt[0]}
                cy={endPt[1]}
                r="11"
                fill="#FC4C02"
                stroke="#FFFFFF"
                strokeWidth="3.5"
              />
            )}
            {/* Start Marker */}
            <circle
              cx={startPt[0]}
              cy={startPt[1]}
              r="11"
              fill="#10B981"
              stroke="#FFFFFF"
              strokeWidth="3.5"
            />
          </svg>
        </div>

        {/* Right: Strava-inspired Route Stats */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: "46px 48px",
            backgroundColor: "#FFFFFF",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            {/* Brand + Mode Pill */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "22px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <div
                  style={{
                    width: "34px",
                    height: "34px",
                    borderRadius: "8px",
                    backgroundColor: "#FC4C02",
                    color: "#FFFFFF",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "20px",
                    fontWeight: 800,
                  }}
                >
                  C
                </div>
                <span
                  style={{
                    fontSize: "22px",
                    fontWeight: 800,
                    color: "#1A1A1E",
                    letterSpacing: "-0.02em",
                  }}
                >
                  ChudRun
                </span>
              </div>
              <div
                style={{
                  backgroundColor: "#FFF2EC",
                  color: "#FC4C02",
                  padding: "6px 14px",
                  borderRadius: "999px",
                  fontSize: "16px",
                  fontWeight: 700,
                }}
              >
                {route.mode === "loop" ? "Scenic Loop" : "Point-to-Point"}
              </div>
            </div>

            {/* Route Name */}
            <div
              style={{
                display: "flex",
                fontSize: "38px",
                fontWeight: 800,
                color: "#111827",
                lineHeight: 1.15,
                marginBottom: "10px",
              }}
            >
              {route.name}
            </div>
            <div
              style={{
                display: "flex",
                fontSize: "20px",
                color: "#64748B",
                marginBottom: "30px",
              }}
            >
              {route.mode === "point-to-point"
                ? `${route.start.shortName} -> ${route.end.shortName}${
                    route.end.rating != null
                      ? ` (${route.end.rating.toFixed(1)}★)`
                      : ""
                  }`
                : `Loop from & back to ${route.start.shortName}`}
            </div>

            {/* Key Metrics */}
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                gap: "18px",
                marginBottom: "28px",
              }}
            >
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  backgroundColor: "#F8FAFC",
                  borderRadius: "16px",
                  padding: "18px 20px",
                  border: "1px solid #E2E8F0",
                }}
              >
                <span style={{ display: "flex", fontSize: "15px", color: "#64748B", fontWeight: 600 }}>
                  DISTANCE
                </span>
                <span style={{ display: "flex", fontSize: "34px", fontWeight: 800, color: "#111827" }}>
                  {`${route.distanceMiles.toFixed(1)} mi`}
                </span>
              </div>

              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  backgroundColor: "#ECFDF5",
                  borderRadius: "16px",
                  padding: "18px 20px",
                  border: "1px solid #A7F3D0",
                }}
              >
                <span style={{ display: "flex", fontSize: "15px", color: "#047857", fontWeight: 600 }}>
                  TRAFFIC-FREE
                </span>
                <span style={{ display: "flex", fontSize: "34px", fontWeight: 800, color: "#065F46" }}>
                  {`${route.trafficFreePct}%`}
                </span>
              </div>

              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  backgroundColor: "#FFF7ED",
                  borderRadius: "16px",
                  padding: "18px 20px",
                  border: "1px solid #FED7AA",
                }}
              >
                <span style={{ display: "flex", fontSize: "15px", color: "#C2410C", fontWeight: 600 }}>
                  SCENERY
                </span>
                <span style={{ display: "flex", fontSize: "34px", fontWeight: 800, color: "#9A3412" }}>
                  {`${route.sceneryScore}/100`}
                </span>
              </div>
            </div>
          </div>

          {/* Footer Highlights & Extra Stats */}
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              flexWrap: "wrap",
              gap: "10px",
              alignItems: "center",
            }}
          >
            {route.elevationGainFt != null && (
              <div
                style={{
                  display: "flex",
                  backgroundColor: "#F1F5F9",
                  color: "#334155",
                  padding: "8px 14px",
                  borderRadius: "10px",
                  fontSize: "16px",
                  fontWeight: 600,
                }}
              >
                {`+${route.elevationGainFt} ft${route.terrainLabel ? ` · ${route.terrainLabel}` : ""}`}
              </div>
            )}
            {route.nightLabel && (
              <div
                style={{
                  display: "flex",
                  backgroundColor: "#EEF2FF",
                  color: "#3730A3",
                  padding: "8px 14px",
                  borderRadius: "10px",
                  fontSize: "16px",
                  fontWeight: 600,
                }}
              >
                {route.nightLabel}
              </div>
            )}
            {route.highlights.slice(0, 2).map((h, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  backgroundColor: "#F1F5F9",
                  color: "#334155",
                  padding: "8px 14px",
                  borderRadius: "10px",
                  fontSize: "16px",
                  fontWeight: 600,
                }}
              >
                {h}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }
  );
}
