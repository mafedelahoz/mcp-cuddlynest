// BE availability API — AO-11 / AO-16, Option B.
//
// This is a LIVE availability call: it counts against the Look-to-Book ratio. It
// is only ever used when a caller explicitly passes source: "live" to
// cuddlynest_search. It must never be wired into the automatic (source "auto")
// fallback chain — that stays DB -> scraping (see fallback-provider.ts).
//
// Contract (given by the backend team, verified against staging 2026-11-09):
// a WebSocket at wss://<host>/get-availability. The client sends one JSON search
// message; the server streams events: "connection", then "availability" (the
// listings), then "info" / "filter" / "sort" (facets). The socket stays open, so
// we close it once "availability" arrives. The handshake needs an Origin header.
// Details and open questions: docs/be-api-notes.md.

import { writeFileSync } from "fs";

import { AuthError, getAccessToken, invalidateAccessToken } from "./auth.js";
import { pickAnchorPlace, resolveDestinations, type DestinationCandidate } from "./cuddlynest.js";
import type { Stay } from "./db.js";
import type { Vertical } from "./fallback-provider.js";

// Staging is the only environment we've been given; production's URL is TBD.
const AVAILABILITY_URL =
  process.env.CUDDLYNEST_BE_AVAILABILITY_URL || "wss://staging-smw-4-0.cuddlynest.com/get-availability";
const AVAILABILITY_ORIGIN = process.env.CUDDLYNEST_BE_ORIGIN || "https://www.cuddlynest.com";
const AVAILABILITY_TIMEOUT_MS = parseInt(process.env.CUDDLYNEST_BE_TIMEOUT_MS || "25000", 10);

// Synthetic viewport around the destination centre (~9.6 km tall x ~18 km wide,
// like a city-level map view on the site).
const HALF_HEIGHT_KM = 4.8;
const HALF_WIDTH_KM = 9.0;

// The response mapping below has been checked against a real staging response
// (Singapore, 2026-11-09). Set back to false if the response shape changes.
const MAPPING_VERIFIED = true;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BeApiErrorCode =
  | AuthError["code"]
  | "missing_dates"
  | "destination_not_found"
  | "timeout"
  | "http_error"
  | "invalid_response"
  | "response_mapping_pending";

export class BeApiError extends Error {
  constructor(
    public readonly code: BeApiErrorCode,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "BeApiError";
  }
}

export interface LiveStaysRequest {
  destination: string;
  checkin?: string;
  checkout?: string;
  adults: number;
  children: number;
  childAges: number[];
  infants: number;
  rooms: number;
  currency: string;
  log?: Log;
}

type Log = (level: "info" | "warn" | "error", message: string, data?: any) => void;

/** Price/availability for one stay — only ever here, never in the static fields. */
export interface LivePricing {
  price: number | null; // discounted / final price shown
  originalPrice: number | null; // struck-through price
  discount: number | null;
  taxesAndFees: number | null;
  freeCancellation: boolean | null;
  breakfastIncluded: boolean | null;
  /** null when the API doesn't say (the staging response carries no currency). */
  currency: string | null;
  checkin: string;
  checkout: string;
}

export interface NearbyPlace {
  name: string;
  distanceKm: number | null;
  walkingMinutes: number | null;
}

/** Non-price, live-only listing context that has no slot in the shared Stay shape. */
export interface LiveDetails {
  neighborhood: string | null;
  distanceFromCenterKm: number | null;
  reviewCount: number | null;
  /** Nearby places by category (landmark, station, parks, food, shopping, airport…). */
  nearby: Record<string, NearbyPlace[]>;
}

/** A static Stay (same shape as the DB path) plus separate `details` and `pricing`. */
export type LiveStay = Stay & { details: LiveDetails; pricing: LivePricing };

export interface LiveStaysResult {
  resolvedLocation: { location: string; lat: number; lng: number; locationType?: string };
  /** True when the backend answered from its own cache rather than suppliers. */
  cached?: boolean;
  stays: LiveStay[];
}

export interface LiveSearchProvider {
  readonly name: string;
  readonly verticals: readonly Vertical[];
  /** Throws BeApiError; never falls back to another source. */
  searchStays(req: LiveStaysRequest): Promise<LiveStaysResult>;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

function viewportBounds(lat: number, lng: number) {
  const dLat = HALF_HEIGHT_KM / 110.574;
  const dLng = HALF_WIDTH_KM / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return {
    northeast: { lat: lat + dLat, lng: lng + dLng },
    southwest: { lat: lat - dLat, lng: lng - dLng },
  };
}

type Place = DestinationCandidate & { lat: number; lon: number };

function placeParts(p: Place) {
  return { city: p.city || p.name || "", state: p.state || "", country: p.country || "" };
}

/** Search message, with the field names of the backend's sample request. */
export function buildAvailabilityRequest(req: LiveStaysRequest, place: Place) {
  return {
    ...placeParts(place),
    viewport_bounds: viewportBounds(place.lat, place.lon),
    autosuggestion_id: place.id,
    page: 1,
    checkin: req.checkin,
    checkout: req.checkout,
    room_count: req.rooms,
    adult_count: req.adults,
    // TODO(AO-16): the sample has no field for child ages or infants; ask FE.
    child_count: req.children,
    sort: ["Recommended"],
  };
}

async function resolvePlace(destination: string): Promise<Place> {
  const places = await resolveDestinations(destination);
  const anchor = pickAnchorPlace(destination, places);
  if (!anchor || anchor.lat == null || anchor.lon == null) {
    throw new BeApiError(
      "destination_not_found",
      `Could not resolve "${destination}" to coordinates for the availability search`,
    );
  }
  return anchor as Place;
}

// ---------------------------------------------------------------------------
// Call (WebSocket)
// ---------------------------------------------------------------------------

interface AvailabilityMessage {
  event: "availability";
  data: unknown;
  is_cached?: boolean;
}

class HandshakeFailed extends Error {}

/** One search over the socket: resolves with the "availability" event, then closes. */
function requestOverSocket(message: unknown, token: string): Promise<AvailabilityMessage> {
  return new Promise((resolve, reject) => {
    let opened = false;
    let settled = false;
    // Node's built-in WebSocket accepts handshake headers as a non-standard option.
    const ws: WebSocket = new (WebSocket as any)(AVAILABILITY_URL, {
      headers: { Origin: AVAILABILITY_ORIGIN, Authorization: `Bearer ${token}` },
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new BeApiError("timeout", `Availability API sent no results within ${AVAILABILITY_TIMEOUT_MS}ms`))),
      AVAILABILITY_TIMEOUT_MS,
    );
    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify(message));
    };
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // ignore non-JSON frames
      }
      if (msg?.event === "availability") finish(() => resolve(msg));
      else if (msg?.event === "error" || (msg?.error && !msg?.event)) {
        const detail = String(msg?.message ?? msg?.error ?? "error").slice(0, 200);
        finish(() => reject(new BeApiError("http_error", `Availability API error: ${detail}`)));
      }
      // "connection", "info", "filter", "sort": not needed here.
    };
    ws.onerror = () => {
      if (!opened) finish(() => reject(new HandshakeFailed()));
    };
    ws.onclose = (ev) => {
      finish(() =>
        reject(
          opened
            ? new BeApiError("unavailable", `Availability socket closed before results (code ${ev.code})`)
            : new HandshakeFailed(),
        ),
      );
    };
  });
}

/** Search with a Bearer token; a refused handshake drops the cached token and retries once. */
async function callAvailability(message: unknown): Promise<AvailabilityMessage> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let token: string;
    try {
      token = await getAccessToken();
    } catch (e) {
      if (e instanceof AuthError) throw new BeApiError(e.code, e.message);
      throw e;
    }
    try {
      return await requestOverSocket(message, token);
    } catch (e) {
      if (!(e instanceof HandshakeFailed)) throw e;
      if (attempt === 0) invalidateAccessToken();
    }
  }
  throw new BeApiError(
    "unauthorized",
    "Availability socket refused the connection (handshake failed twice; check token, Origin and URL)",
  );
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------
//
// Field names verified against a real staging response (listed first in each
// alias list). The other aliases are kept so small backend renames don't break
// the mapping; adjusting to a changed response should only mean editing these
// tables.
//
// The mapper never throws on unexpected input. It returns a MappingReport
// naming which expected fields were missing and which response keys went unused
// (key names and counts only — never values), so the fix is quick.

/** Where the listings array might live, tried in order. */
const LISTINGS_PATHS = [
  "data.listings", "data.results", "data.hotels", "data.properties",
  "listings", "results", "hotels", "properties", "data",
];

/** Field -> candidate keys on a listing. Dotted keys and `[0]` are allowed. */
const FIELDS = {
  // static
  id: ["product_id", "productId", "id"],
  name: ["hotel_name", "name", "product_title", "title"],
  slug: ["slug", "seourl"],
  propertyType: ["main_property_type", "propertyType", "property_type", "home_type"],
  starRating: ["star_rating", "starRating", "stars"],
  reviewScore: ["grs_new", "reviewScore", "review_score", "rating"],
  reviewLabel: ["grs_adjective_new", "reviewLabel", "review_label"],
  reviewCount: ["grs_total_reviews", "reviewCount", "review_count"],
  neighborhood: ["neighborhood", "neighbourhood", "area"],
  distanceFromCenter: ["distance", "distanceFromCenter", "distance_from_center"],
  distanceUnit: ["distance_unit"],
  coverImage: ["product_images[0]", "coverImage", "cover_image", "image", "images[0]"],
  url: ["url", "listingUrl", "listing_url"],
  // optional static (not seen on the page; used when present)
  city: ["city", "location.city"],
  country: ["country", "location.country"],
  // GeoJSON point: coordinates are [lng, lat].
  lat: ["location.coordinates[1]", "lat", "latitude", "location.lat"],
  lng: ["location.coordinates[0]", "lng", "lon", "longitude", "location.lng"],
  nearby: ["tags"],
  description: ["description", "short_description"],
  amenities: ["amenities", "featured_amenities"],
  // pricing
  price: ["discounted_price", "price", "discountedPrice", "finalPrice", "final_price"],
  originalPrice: ["lowest_price", "originalPrice", "original_price", "strikePrice", "strike_price"],
  discount: ["discount"],
  taxesAndFees: ["fees", "taxesAndFees", "taxes_and_fees", "taxes"],
  freeCancellation: ["is_free_cancellation", "freeCancellation", "free_cancellation", "isFreeCancellation"],
  breakfastIncluded: ["is_breakfast_included", "breakfastIncluded"],
  currency: ["currency"],
} as const;

type Field = keyof typeof FIELDS;

/**
 * Always present in the real response — reported when missing. (Free
 * cancellation and neighbourhood are optional per listing, so they're mapped
 * when present but not reported.)
 */
const EXPECTED: Field[] = [
  "id", "name", "propertyType", "starRating", "reviewScore", "reviewLabel", "reviewCount",
  "distanceFromCenter", "coverImage", "price", "originalPrice", "taxesAndFees",
];

export interface MappingReport {
  listingsPath: string | null; // where the listings array was found
  listingCount: number;
  mapped: number;
  dropped: number; // listings without an id, or that failed to map
  missingExpected: Partial<Record<Field, number>>; // field -> listings missing it
  unusedKeys: string[]; // listing keys no alias consumed (names only)
}

function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split(".")) {
    const m = part.match(/^(.+)\[(\d+)\]$/);
    cur = cur?.[m ? m[1] : part];
    if (m) cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined;
    if (cur == null) return undefined;
  }
  return cur;
}

function pick(listing: unknown, field: Field, used: Set<string>): unknown {
  for (const key of FIELDS[field]) {
    const v = getPath(listing, key);
    if (v != null && v !== "") {
      used.add(key.split(/[.[]/)[0]);
      return v;
    }
  }
  return undefined;
}

/** 1234.5 or "COP 1,234,567" or "$1.234,50"-ish -> number; null when unreadable. */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && v !== null && "amount" in v) return toNumber((v as any).amount);
  if (typeof v !== "string") return null;
  const digits = v.replace(/[^\d.,-]/g, "");
  if (!digits) return null;
  // Treat the last separator followed by 1-2 digits as the decimal point.
  const m = digits.match(/^(.*?)[.,](\d{1,2})$/);
  const n = m ? Number(`${m[1].replace(/[.,]/g, "")}.${m[2]}`) : Number(digits.replace(/[.,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true" || v === "yes") return true;
  if (v === 0 || v === "0" || v === "false" || v === "no") return false;
  return null;
}

function toStr(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

/** "8.6 Superb (763)" -> { score: 8.6, label: "Superb", count: 763 }. */
export function parseReviewText(text: string) {
  const m = text.trim().match(/^(\d+(?:[.,]\d+)?)\s*(.*?)\s*(?:\((\d[\d,.]*)\))?$/);
  if (!m) return undefined;
  return {
    score: Number(m[1].replace(",", ".")),
    label: m[2] || null,
    count: m[3] ? Number(m[3].replace(/[,.]/g, "")) : null,
  };
}

function findListings(json: unknown): { path: string | null; listings: unknown[] } {
  if (Array.isArray(json)) return { path: "(root)", listings: json };
  for (const path of LISTINGS_PATHS) {
    const v = getPath(json, path);
    if (Array.isArray(v) && v.some((x) => x && typeof x === "object")) return { path, listings: v };
  }
  return { path: null, listings: [] };
}

function slugTag(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface MappingContext {
  checkin: string;
  checkout: string;
  currency: string | null;
  /** City/country of the searched place, used when a listing doesn't carry its own. */
  city?: string | null;
  country?: string | null;
}

/** `{ landmark: [{ name, distance, walking_distance }], … }` -> NearbyPlace lists (max 3 each). */
function toNearby(tags: unknown): Record<string, NearbyPlace[]> {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return {};
  const out: Record<string, NearbyPlace[]> = {};
  for (const [category, items] of Object.entries(tags as Record<string, unknown>)) {
    if (!Array.isArray(items)) continue;
    const places = items
      .map((it: any) => ({
        name: toStr(it?.name) ?? "",
        distanceKm: toNumber(it?.distance),
        walkingMinutes: toNumber(it?.walking_distance),
      }))
      .filter((p) => p.name)
      .slice(0, 3);
    if (places.length) out[category] = places;
  }
  return out;
}

function mapListing(listing: any, ctx: MappingContext, missing: Set<Field>, used: Set<string>): LiveStay | null {
  const get = (f: Field) => {
    const v = pick(listing, f, used);
    if (v === undefined) missing.add(f);
    return v;
  };

  const id = toStr(get("id"));
  if (!id) return null;

  let reviewScore = toNumber(get("reviewScore"));
  let reviewLabel = toStr(get("reviewLabel"));
  let reviewCount = toNumber(get("reviewCount"));
  // The page shows "8.6 Superb (763)"; the API may send it as one string.
  const combined = reviewLabel ? parseReviewText(reviewLabel) : undefined;
  if (combined && /^\d/.test(reviewLabel!)) {
    reviewScore ??= combined.score;
    reviewLabel = combined.label;
    reviewCount ??= combined.count;
    // Derived, so not actually missing from the response.
    missing.delete("reviewScore");
    if (reviewCount != null) missing.delete("reviewCount");
  }

  const name = toStr(get("name")) ?? `Stay ${id}`;
  const propertyType = toStr(get("propertyType"));
  const stars = toNumber(get("starRating"));
  const cover = get("coverImage");
  const coverUrl = toStr(Array.isArray(cover) ? cover[0] : (cover as any)?.url ?? cover);
  const rawUrl = toStr(get("url"));
  const amenities = get("amenities");
  const lat = toNumber(get("lat"));
  const lng = toNumber(get("lng"));

  // With no reviews the API still sends a label (e.g. "poor"); don't show it.
  const hasReviews = reviewCount == null || reviewCount > 0;
  const breakfast = toBool(pick(listing, "breakfastIncluded", used));
  const nearby = toNearby(pick(listing, "nearby", used));
  const airport = nearby.airport?.[0];
  const tags = [
    propertyType && slugTag(propertyType),
    stars && stars > 0 ? `${stars}-star` : null,
    hasReviews && reviewLabel ? slugTag(reviewLabel) : null,
    breakfast ? "breakfast-included" : null,
  ].filter((t): t is string => !!t);

  const stay: Stay = {
    id,
    type: "stay",
    name,
    slug: toStr(get("slug")),
    category: propertyType,
    location: {
      city: toStr(get("city")) ?? ctx.city ?? null,
      country: toStr(get("country")) ?? ctx.country ?? null,
      lat,
      lng,
      nearest_airport: airport ? { name: airport.name, distance_km: airport.distanceKm } : null,
    },
    tags: [...new Set(tags)],
    description_short: toStr(get("description"))?.slice(0, 300) ?? null,
    amenities: Array.isArray(amenities)
      ? amenities.map((a: any) => toStr(a?.name ?? a)).filter((a): a is string => !!a)
      : [],
    rating: hasReviews ? reviewScore || null : null,
    cover_image_url: coverUrl,
    url: rawUrl
      ? /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://www.cuddlynest.com/${rawUrl.replace(/^\/+/, "")}`
      : `https://www.cuddlynest.com/hotel/-${id}`,
  };

  const distance = toNumber(get("distanceFromCenter"));
  const unit = toStr(pick(listing, "distanceUnit", used))?.toLowerCase();
  const distanceKm =
    distance == null ? null : unit === "mi" ? Math.round(distance * 1.609 * 100) / 100 : unit === "m" ? distance / 1000 : distance;
  return {
    ...stay,
    details: {
      neighborhood: toStr(get("neighborhood")),
      distanceFromCenterKm: distanceKm,
      reviewCount,
      nearby,
    },
    pricing: {
      price: toNumber(get("price")),
      originalPrice: toNumber(get("originalPrice")),
      discount: toNumber(pick(listing, "discount", used)),
      taxesAndFees: toNumber(get("taxesAndFees")),
      freeCancellation: toBool(get("freeCancellation")),
      breakfastIncluded: breakfast,
      currency: toStr(pick(listing, "currency", used)) ?? ctx.currency,
      checkin: ctx.checkin,
      checkout: ctx.checkout,
    },
  };
}

/**
 * Availability response -> LiveStay[] (static Stay fields + separate `details`
 * and `pricing`). Never throws: unexpected input yields fewer stays and a
 * report saying why.
 */
export function mapAvailabilityResponse(
  json: unknown,
  ctx: MappingContext,
): { stays: LiveStay[]; report: MappingReport } {
  const { path, listings } = findListings(json);
  const report: MappingReport = {
    listingsPath: path,
    listingCount: listings.length,
    mapped: 0,
    dropped: 0,
    missingExpected: {},
    unusedKeys: [],
  };
  const stays: LiveStay[] = [];
  const allKeys = new Set<string>();
  const used = new Set<string>();

  for (const listing of listings) {
    if (!listing || typeof listing !== "object") {
      report.dropped++;
      continue;
    }
    Object.keys(listing).forEach((k) => allKeys.add(k));
    const missing = new Set<Field>();
    try {
      const stay = mapListing(listing, ctx, missing, used);
      if (stay) {
        stays.push(stay);
        report.mapped++;
      } else report.dropped++;
    } catch {
      report.dropped++;
    }
    for (const f of missing) {
      if (EXPECTED.includes(f)) report.missingExpected[f] = (report.missingExpected[f] ?? 0) + 1;
    }
  }
  report.unusedKeys = [...allKeys].filter((k) => !used.has(k)).sort();
  return { stays, report };
}

/** One-line, value-free summary of a report for logs and errors. */
export function summarizeReport(r: MappingReport): string {
  const missing = Object.entries(r.missingExpected).map(([f, n]) => `${f}(${n})`).join(", ");
  return (
    `listings at ${r.listingsPath ?? "NOT FOUND"}: ${r.mapped}/${r.listingCount} mapped` +
    (r.dropped ? `, ${r.dropped} dropped` : "") +
    (missing ? `; missing expected: ${missing}` : "") +
    (r.unusedKeys.length ? `; unused keys: ${r.unusedKeys.join(", ")}` : "")
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const beApiSearchProvider: LiveSearchProvider = {
  name: "be_availability",
  verticals: ["stays"],

  async searchStays(req) {
    if (!req.checkin || !req.checkout) {
      throw new BeApiError("missing_dates", "checkin and checkout (YYYY-MM-DD) are required for source \"live\"");
    }
    const place = await resolvePlace(req.destination);
    const message = buildAvailabilityRequest(req, place);
    const result = await callAvailability(message);

    // Local inspection aid: save the raw availability event when asked to (never in production).
    const captureFile = process.env.CUDDLYNEST_BE_CAPTURE_FILE;
    if (captureFile) {
      try {
        writeFileSync(captureFile, JSON.stringify(result, null, 2));
      } catch {
        /* best effort */
      }
    }

    const { stays, report } = mapAvailabilityResponse(result, {
      checkin: req.checkin,
      checkout: req.checkout,
      // The search message carries no currency and the response doesn't state one.
      currency: null,
      city: message.city || null,
      country: message.country || null,
    });
    req.log?.(
      report.mapped && !Object.keys(report.missingExpected).length ? "info" : "warn",
      "Availability response mapping",
      { summary: summarizeReport(report) },
    );

    if (!MAPPING_VERIFIED) {
      throw new BeApiError(
        "response_mapping_pending",
        `Availability API answered, but the response mapping hasn't been verified against ` +
          `a real response yet (${summarizeReport(report)}).`,
      );
    }

    return {
      resolvedLocation: {
        location: [message.city, message.state, message.country].filter(Boolean).join(", "),
        lat: place.lat,
        lng: place.lon,
        locationType: place.type,
      },
      cached: result.is_cached,
      stays,
    };
  },
};
