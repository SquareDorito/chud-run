import { NextRequest, NextResponse } from "next/server";
import {
  payloadToRunRoute,
  toSharedRoutePayload,
  type SharedRoutePayload,
} from "@/lib/share";
import { saveSharedRoute } from "@/lib/share-store";
import type { RunRoute } from "@/lib/types";

const MAX_BODY_BYTES = 160 * 1024; // 160 KB cap for full high-res route coordinates

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    if (!raw || raw.length > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "Invalid route payload size." },
        { status: 400 }
      );
    }

    const body = JSON.parse(raw) as {
      route?: RunRoute;
      payload?: SharedRoutePayload;
    };

    let payload: SharedRoutePayload | null = null;
    if (body.route && Array.isArray(body.route.coordinates)) {
      payload = toSharedRoutePayload(body.route);
    } else if (body.payload && Array.isArray(body.payload.coords)) {
      payload = body.payload;
    }

    if (!payload || !payloadToRunRoute(payload)) {
      return NextResponse.json(
        { error: "Missing valid route coordinates." },
        { status: 400 }
      );
    }

    const id = await saveSharedRoute(payload);
    return NextResponse.json({
      id,
      path: `/r/${id}`,
      ogPath: `/api/og?id=${id}`,
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to create share link." },
      { status: 500 }
    );
  }
}
