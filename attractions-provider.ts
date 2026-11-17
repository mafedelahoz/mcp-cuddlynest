// Attractions search — AO-10 / AO-13.
//
// Reads CuddlyNest's attractions shopping service (GET /v2.2/activities/), the
// same API the site's attractions results page uses. Results carry a "from"
// price, so until the backend confirms whether this search can reach suppliers
// (L2B), it is treated like the stays live call: only on an explicit
// source: "live", never from "auto" / "db", and it never falls back.
//
// Contract: Swagger on staging (the reference per the backend team; prod has the
// same schema with Swagger off), checked against real staging responses
// (Dubai, Bangkok, 2026-11-16).
//
// AO-10: there is no attractions database (inventory comes from suppliers via
// this service), so every live search also fills a per-destination cache. With
// source "auto" / "db" the MCP answers from that cache only, refreshed in the
// background (HTTP mode) and never served past its max age. Details and open questions:
// docs/private/attractions-flights-notes.md (kept out of the public repo).

import { JsonCache, cacheFilePath, envHours } from "./cache.js";
import { parseDestination } from "./destination.js";

// Staging is the only environment confirmed so far; production's URL is TBD.
const ATTRACTIONS_API_URL = (
  process.env.CUDDLYNEST_ATTRACTIONS_API_URL || "https://staging-attractions-shopping-service.cuddlynest.com"
).replace(/\/+$/, "");
const ATTRACTIONS_SITE_URL = (process.env.CUDDLYNEST_ATTRACTIONS_SITE_URL || "https://www.cuddlynest.com").replace(/\/+$/, "");
const ATTRACTIONS_TIMEOUT_MS = parseInt(process.env.CUDDLYNEST_ATTRACTIONS_TIMEOUT_MS || "20000", 10);

const MAX_LIMIT = 50; // the API's results_per_page maximum
const DESCRIPTION_MAX = 240;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AttractionsErrorCode = "invalid_destination" | "timeout" | "http_error" | "invalid_response";

export class AttractionsError extends Error {
  constructor(
    public readonly code: AttractionsErrorCode,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "AttractionsError";
  }
}

type Log = (level: "info" | "warn" | "error", message: string, data?: any) => void;

/** Same static shape as a Stay, with `type: "attraction"` and a duration. */
export interface Attraction {
  id: string;
  type: "attraction";
  name: string;
  slug: string | null;
  category: string | null;
  location: {
    city: string | null;
    country: string | null;
    lat: number | null;
    lng: number | null;
    nearest_airport: null;
  };
  tags: string[];
  description_short: string | null;
  amenities: string[];
  duration: { minutes: number | null; label: string | null; iso: string | null } | null;
  rating: number | null; // 0-5 scale (stays use 0-10)
  cover_image_url: string | null;
  url: string;
  details: {
    reviewCount: number | null;
    subCategories: string[];
    languages: string[];
    wheelchairAccess: boolean | null;
    familyFriendly: boolean | null;
  };
  /** "From" price — only ever here, never in the static fields. */
  pricing: {
    price: number | null;
    discount: number | null;
    currency: string | null;
    available: boolean | null;
    limitedAvailability: boolean | null;
    /** The date the API priced against (its search_date). */
    date: string | null;
  };
}

export interface AttractionsRequest {
  destination: string;
  limit?: number;
  log?: Log;
}

export interface AttractionsResult {
  resolvedLocation: { city: string; country: string | null; userLocation: string };
  totalCount: number | null;
  attractions: Attraction[];
  /** When the results were read from the API (now for live, earlier for cache). */
  cachedAt: string;
}

// ---------------------------------------------------------------------------
// Cache (AO-10)
// ---------------------------------------------------------------------------

export const attractionsCache = new JsonCache({
  label: "Attractions",
  file: cacheFilePath("CUDDLYNEST_ATTRACTIONS_CACHE_FILE", "attractions-cache.json"),
  maxAgeMs: () => envHours("CUDDLYNEST_ATTRACTIONS_CACHE_MAX_AGE_HOURS", 24) * 3_600_000,
  maxEntries: 300,
});

type CachedAttractions = Omit<AttractionsResult, "cachedAt" | "attractions"> & { attractions: Attraction[] };

/** Cache key for a destination: the normalized user_location the API is called with. */
export function attractionsCacheKey(destination: string): string {
  return `attractions:${buildActivitiesQuery(destination).get("user_location")!.toLowerCase().replace(/\s+/g, " ")}`;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Query string for GET /v2.2/activities/ (destination search, page 1). */
export function buildActivitiesQuery(destination: string, limit?: number): URLSearchParams {
  const parsed = parseDestination(destination);
  const city = parsed.city.trim();
  if (!city) throw new AttractionsError("invalid_destination", "Provide a destination city.");
  const region = parsed.kind === "ok" ? parsed.country || parsed.state : undefined;
  const q = new URLSearchParams({
    search_parameter: city,
    // "City, Country" | "City, State, Country"; ambiguous / bare city -> as typed.
    user_location: region ? `${city}, ${region}` : destination.trim(),
    search_type: "destination",
    results_per_page: String(clampLimit(limit)),
    page_number: "1",
  });
  return q;
}

function clampLimit(limit?: number): number {
  return Math.min(Math.max(1, Math.floor(Number(limit) || 20)), MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => !!s) : []);

function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function shortDescription(text: string | null): string | null {
  if (!text) return null;
  const clean = text.replace(/^[\s*•·-]+/, "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > DESCRIPTION_MAX ? `${clean.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : clean;
}

function coverImage(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  for (const img of images) {
    const url = str(img?.large) ?? str(img?.extra_large) ?? str(img?.medium) ?? str(img?.small);
    if (url) return url;
  }
  return null;
}

export interface AttractionsMappingContext {
  city: string | null;
  country: string | null;
  searchDate: string | null;
}

function mapActivity(a: any, ctx: AttractionsMappingContext): Attraction | null {
  const id = str(a?.id);
  if (!id) return null;
  const name = str(a.title) ?? `Activity ${id}`;
  const reviewCount = num(a.ratings?.total);
  // With no reviews the API sends "" or "0.0": no rating rather than a 0.
  const rating = reviewCount ? num(a.ratings?.average) : null;
  const minutes = num(a.duration);
  const label = str(a.duration_hours);
  const iso = str(a.iso_duration);
  const discount = num(a.price?.discount);
  const category = str(a.category);

  return {
    id,
    type: "attraction",
    name,
    slug: slugify(name) || null,
    category,
    location: {
      city: str(a.city_name) ?? ctx.city,
      country: str(a.country_name) ?? ctx.country,
      lat: num(a.geoCode?.lat),
      lng: num(a.geoCode?.lng),
      nearest_airport: null,
    },
    tags: [...new Set(strings(a.tags).map(slugify).filter(Boolean))],
    description_short: shortDescription(str(a.descriptions)),
    amenities: [],
    duration: minutes || label || iso ? { minutes, label, iso } : null,
    rating,
    cover_image_url: coverImage(a.images),
    url: `${ATTRACTIONS_SITE_URL}/attractions/detail/${encodeURIComponent(id)}`,
    details: {
      reviewCount,
      subCategories: strings(a.subCategories),
      languages: strings(a.languages),
      wheelchairAccess: bool(a.wheelchair_access),
      familyFriendly: bool(a.isfamily_friendly),
    },
    pricing: {
      price: num(a.price?.price),
      // price.originalPrice is left out on purpose: on staging it is always ~5%
      // BELOW price (111 vs 116.55), so it looks like the net rate before markup,
      // not a struck-through price. Don't expose it until the backend says what it is.
      discount: discount || null,
      currency: str(a.price?.currency),
      available: bool(a.price?.available),
      limitedAvailability: bool(a.limitedAvailability),
      date: ctx.searchDate,
    },
  };
}

/** /v2.2/activities/ response -> Attraction[]. Never throws on odd shapes. */
export function mapActivitiesResponse(
  body: unknown,
  ctx: Omit<AttractionsMappingContext, "searchDate">,
): { attractions: Attraction[]; totalCount: number | null; dropped: number } {
  const b = body as any;
  const list: unknown[] = Array.isArray(b?.activities) ? b.activities : [];
  const full = { ...ctx, searchDate: str(b?.search_date) };
  const attractions = list.map((a) => mapActivity(a, full)).filter((a): a is Attraction => !!a);
  return {
    attractions,
    // Page 1 without filters can take the API's fast path, which only has an estimate.
    totalCount: num(b?.total_count) ?? num(b?.assumed_total_count),
    dropped: list.length - attractions.length,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

async function fetchAttractions(destination: string, log?: Log): Promise<CachedAttractions> {
  // Always the API's page maximum, so the cached list can serve any `limit`.
  const query = buildActivitiesQuery(destination, MAX_LIMIT);
  const url = `${ATTRACTIONS_API_URL}/v2.2/activities/?${query}`;
  const started = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(ATTRACTIONS_TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new AttractionsError("timeout", `Attractions search timed out after ${ATTRACTIONS_TIMEOUT_MS} ms.`);
    }
    throw new AttractionsError("http_error", `Attractions search failed: ${e?.message ?? e}`);
  }
  if (!res.ok) {
    throw new AttractionsError("http_error", `Attractions search answered HTTP ${res.status}.`, res.status);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AttractionsError("invalid_response", "Attractions search did not return JSON.");
  }
  if (!body || typeof body !== "object" || !Array.isArray((body as any).activities)) {
    throw new AttractionsError("invalid_response", "Attractions search response has no `activities` list.");
  }

  const parsed = parseDestination(destination);
  const city = query.get("search_parameter")!;
  const country = parsed.kind === "ok" ? parsed.country ?? null : null;
  const { attractions, totalCount, dropped } = mapActivitiesResponse(body, { city, country });
  log?.("info", "Attractions search", { destination, count: attractions.length, dropped, ms: Date.now() - started });
  return { resolvedLocation: { city, country, userLocation: query.get("user_location")! }, totalCount, attractions };
}

/** Live search (source "live"). Also refreshes the destination's cache entry. */
export async function searchAttractions(req: AttractionsRequest): Promise<AttractionsResult> {
  const r = await fetchAttractions(req.destination, req.log);
  const key = attractionsCacheKey(req.destination);
  const cachedAt = r.attractions.length
    ? attractionsCache.set(key, r, req.destination)
    : new Date().toISOString();
  return { ...r, attractions: r.attractions.slice(0, clampLimit(req.limit)), cachedAt };
}

/** Cache-only read (source "auto" / "db"): never calls the API. */
export function getCachedAttractions(destination: string, limit?: number): AttractionsResult | undefined {
  const hit = attractionsCache.get<CachedAttractions>(attractionsCacheKey(destination));
  if (!hit) return undefined;
  return { ...hit.value, attractions: hit.value.attractions.slice(0, clampLimit(limit)), cachedAt: hit.cachedAt };
}

export interface AttractionsRefreshSummary {
  destinations: number;
  refreshed: number;
  emptied: number;
  failed: number;
  failures: { destination: string; code: string }[];
  durationMs: number;
}

/** Re-read every cached destination from the API. Failures are counted and kept, not thrown. */
export async function refreshAttractionsCache(log?: Log): Promise<AttractionsRefreshSummary> {
  const started = Date.now();
  const entries = attractionsCache.entriesList<string>();
  const summary: AttractionsRefreshSummary = {
    destinations: entries.length, refreshed: 0, emptied: 0, failed: 0, failures: [], durationMs: 0,
  };
  try {
    for (const e of entries) {
      if (!e.meta) continue;
      try {
        const r = await fetchAttractions(e.meta);
        if (r.attractions.length) {
          attractionsCache.set(e.key, r, e.meta, { flush: false });
          summary.refreshed++;
        } else {
          attractionsCache.delete(e.key, { flush: false });
          summary.emptied++;
        }
      } catch (err) {
        // The old entry stays until it ages out, so a failed refresh never serves stale data.
        summary.failed++;
        const code = err instanceof AttractionsError ? err.code : "unexpected_error";
        summary.failures.push({ destination: e.meta, code });
        log?.("warn", "Attractions cache refresh failed", { destination: e.meta, code });
      }
    }
  } finally {
    attractionsCache.flush();
    summary.durationMs = Date.now() - started;
  }
  return summary;
}

let refreshTimer: NodeJS.Timeout | undefined;

/** Background refresh (HTTP mode only). Interval defaults to half the max age. */
export function startAttractionsCacheRefresh(log: Log): { intervalMs: number } | undefined {
  if (refreshTimer) return undefined;
  const hours = envHours(
    "CUDDLYNEST_ATTRACTIONS_CACHE_REFRESH_INTERVAL_HOURS",
    attractionsCache.maxAgeMs() / 3_600_000 / 2,
  );
  if (!(hours > 0)) return undefined;
  const intervalMs = Math.min(Math.round(hours * 3_600_000), 2 ** 31 - 1);
  let running = false;
  refreshTimer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const summary = await refreshAttractionsCache(log);
      log(summary.failed ? "warn" : "info", "Attractions cache background refresh", summary);
    } finally {
      running = false;
    }
  }, intervalMs);
  refreshTimer.unref();
  return { intervalMs };
}
