import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  payloadToRunRoute,
  type SharedRoutePayload,
} from "@/lib/share";
import type { RunRoute } from "@/lib/types";

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SHARE_ID_RE = /^[A-Za-z0-9]{6,16}$/;
const MEMORY_CACHE_MAX = 2000;

const memoryStore = new Map<string, SharedRoutePayload>();

function remember(id: string, payload: SharedRoutePayload) {
  if (memoryStore.size >= MEMORY_CACHE_MAX) {
    const oldest = memoryStore.keys().next().value;
    if (oldest) memoryStore.delete(oldest);
  }
  memoryStore.set(id, payload);
}

function getCandidateDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.SHARE_STORE_DIR) {
    dirs.push(process.env.SHARE_STORE_DIR);
  }
  dirs.push(path.join(process.cwd(), ".chudrun-shares"));
  dirs.push(path.join(os.tmpdir(), "chudrun-shares"));
  return dirs;
}

function deriveShortId(json: string): string {
  const hash = crypto.createHash("sha256").update(json).digest();
  // Convert first 6 bytes (48 bits) into an 8-character base62 string
  let value = BigInt(0);
  for (let i = 0; i < 6; i++) {
    value = (value << BigInt(8)) | BigInt(hash[i]);
  }
  let out = "";
  const base = BigInt(62);
  for (let i = 0; i < 8; i++) {
    out = BASE62[Number(value % base)] + out;
    value /= base;
  }
  return out;
}

export function isValidShareId(id: string): boolean {
  return SHARE_ID_RE.test(id);
}

export async function saveSharedRoute(
  payload: SharedRoutePayload
): Promise<string> {
  const json = JSON.stringify(payload);
  const id = deriveShortId(json);
  remember(id, payload);

  for (const dir of getCandidateDirs()) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${id}.json`);
      // Avoid rewriting if identical content-addressed file already exists
      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, json, "utf8");
      }
      return id;
    } catch {
      // Try next directory fallback
    }
  }

  // In-memory store still holds the route even if disk is read-only
  return id;
}

export async function getSharedRouteById(id: string): Promise<RunRoute | null> {
  if (!isValidShareId(id)) return null;

  const cached = memoryStore.get(id);
  if (cached) {
    return payloadToRunRoute(cached);
  }

  for (const dir of getCandidateDirs()) {
    try {
      const filePath = path.join(dir, `${id}.json`);
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as SharedRoutePayload;
      const route = payloadToRunRoute(parsed);
      if (route) {
        remember(id, parsed);
        return route;
      }
    } catch {
      // Try next directory
    }
  }

  return null;
}
