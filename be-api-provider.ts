// BE availability API ("Wide availability") — AO-11, Option B.
//
// This is a LIVE supplier call: it counts against the Look-to-Book ratio. It is
// only ever used when a caller explicitly passes source: "live" to
// cuddlynest_search. It must never be wired into the automatic (source "auto")
// fallback chain — that stays DB -> scraping (see fallback-provider.ts).
//
// Request contract: captured from www.cuddlynest.com live traffic (Paris search).
// Response contract: NOT YET SEEN. mapAvailabilityResponse() is written against a
// SIMULATED fixture with assumed field names, and stays switched off
// (MAPPING_VERIFIED = false -> "response_mapping_pending") until it has been
// checked against a real response. What's known vs assumed: docs/be-api-notes.md.

import { randomBytes, randomUUID } from "crypto";
import { writeFileSync } from "fs";
import fetch from "node-fetch";

import { AuthError, getAccessToken, invalidateAccessToken } from "./auth.js";
import { pickAnchorPlace, resolveDestinations, type DestinationCandidate } from "./cuddlynest.js";
import type { Stay } from "./db.js";
import type { Vertical } from "./fallback-provider.js";

const AVAILABILITY_URL =
  process.env.CUDDLYNEST_BE_AVAILABILITY_URL || "https://secure-smw-3-0.cuddlynest.com/api/availability";
const AVAILABILITY_TIMEOUT_MS = parseInt(process.env.CUDDLYNEST_BE_TIMEOUT_MS || "25000", 10);

// Synthetic viewport around the destination centre. Sized like the captured
// Paris search at zoom_level 13 (~9.6 km tall x ~18 km wide).
const HALF_HEIGHT_KM = 4.8;
const HALF_WIDTH_KM = 9.0;
const ZOOM_LEVEL = 13;

// One per server process; the site generates it client-side (16 hex chars).
const SESSION_ID = randomBytes(8).toString("hex");

// Flip to true only after mapAvailabilityResponse() has been checked against a
// real captured response (scripts/capture-availability.mjs). See docs/be-api-notes.md.
const MAPPING_VERIFIED = false;

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
  taxesAndFees: number | null;
  freeCancellation: boolean | null;
  currency: string;
  checkin: string;
  checkout: string;
}

/** Non-price, live-only listing context that has no slot in the shared Stay shape. */
export interface LiveDetails {
  neighborhood: string | null;
  distanceFromCenterKm: number | null;
  reviewCount: number | null;
}

/** A static Stay (same shape as the DB path) plus separate `details` and `pricing`. */
export type LiveStay = Stay & { details: LiveDetails; pricing: LivePricing };

export interface LiveStaysResult {
  resolvedLocation: { location: string; lat: number; lng: number; locationType?: string };
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

function boundingBox(lat: number, lng: number) {
  const dLat = HALF_HEIGHT_KM / 110.574;
  const dLng = HALF_WIDTH_KM / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  // As captured: a = north-east corner, b = south-west corner.
  return { aLat: lat + dLat, aLng: lng + dLng, bLat: lat - dLat, bLng: lng - dLng };
}

function placeLabel(p: DestinationCandidate): string {
  return [p.city || p.name, p.state, p.country].filter(Boolean).join(", ");
}

/** Request body using the field names seen in the live capture. */
export function buildAvailabilityBody(
  req: LiveStaysRequest,
  place: DestinationCandidate & { lat: number; lon: number },
  requestId: string = randomUUID(),
) {
  return {
    location: placeLabel(place),
    property_count: place.propertyCount != null ? String(place.propertyCount) : undefined,
    location_type: place.type,
    checkin: req.checkin,
    checkout: req.checkout,
    adults: req.adults,
    rooms: req.rooms,
    currency: req.currency,
    numberOfChildrenBelow17: req.children,
    child_ages: req.childAges,
    numberOfChildrenBelow2: req.infants,
    ...boundingBox(place.lat, place.lon),
    lat: place.lat,
    lng: place.lon,
    type: "viewport",
    landmarks: [],
    // The captured "price": "Lowest" was only the UI's sort choice; left out.
    filter_info: { expanded_map: false },
    page: 1,
    sessionid: SESSION_ID,
    zoom_level: ZOOM_LEVEL,
    user_country: process.env.CUDDLYNEST_BE_USER_COUNTRY || "United States",
    requestId,
    is_crypto: 0,
  };
}

async function resolvePlace(destination: string) {
  const places = await resolveDestinations(destination);
  const anchor = pickAnchorPlace(destination, places);
  if (!anchor || anchor.lat == null || anchor.lon == null) {
    throw new BeApiError(
      "destination_not_found",
      `Could not resolve "${destination}" to coordinates for the availability search`,
    );
  }
  return anchor as DestinationCandidate & { lat: number; lon: number };
}

// ---------------------------------------------------------------------------
// Call
// ---------------------------------------------------------------------------

async function postAvailability(body: unknown, token: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AVAILABILITY_TIMEOUT_MS);
  try {
    const res = await fetch(AVAILABILITY_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    if ((err as any)?.name === "AbortError") {
      throw new BeApiError("timeout", `Availability API exceeded ${AVAILABILITY_TIMEOUT_MS}ms`);
    }
    throw new BeApiError("unavailable", `Availability API unreachable (${(err as any)?.code ?? "network"})`);
  } finally {
    clearTimeout(timer);
  }
}

/** POST with a Bearer token; on 401 the cached token is dropped and the call retried once. */
async function callAvailability(body: unknown): Promise<unknown> {
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    let token: string;
    try {
      token = await getAccessToken();
    } catch (e) {
      if (e instanceof AuthError) throw new BeApiError(e.code, e.message);
      throw e;
    }
    res = await postAvailability(body, token);
    if (res.status !== 401 || attempt === 1) break;
    invalidateAccessToken();
  }
  if (res!.status === 401 || res!.status === 403) {
    throw new BeApiError("unauthorized", `Availability API rejected the token (HTTP ${res!.status})`, res!.status);
  }
  if (res!.status < 200 || res!.status >= 300) {
    throw new BeApiError("http_error", `Availability API returned HTTP ${res!.status}`, res!.status);
  }
  try {
    return JSON.parse(res!.text);
  } catch {
    throw new BeApiError("invalid_response", "Availability API returned non-JSON", res!.status);
  }
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------
//
// ASSUMED FIELD NAMES. Nothing below has been checked against a real response
// yet: the listing fields are the ones visible on the rendered results page,
// named by guesswork (see docs/be-api-notes.md). Every field lists aliases;
// adjusting to the real response should only mean editing these tables.
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
  name: ["name", "product_title", "title"],
  slug: ["slug", "seourl"],
  propertyType: ["propertyType", "property_type", "home_type"],
  starRating: ["starRating", "star_rating", "stars"],
  reviewScore: ["reviewScore", "review_score", "grs_new", "rating"],
  reviewLabel: ["reviewLabel", "review_label", "grs_adjective_new"],
  reviewCount: ["reviewCount", "review_count", "grs_total_reviews"],
  neighborhood: ["neighborhood", "neighbourhood", "area"],
  distanceFromCenter: ["distanceFromCenter", "distance_from_center", "distance"],
  coverImage: ["coverImage", "cover_image", "image", "images[0]", "product_images[0]"],
  url: ["url", "listingUrl", "listing_url"],
  // optional static (not seen on the page; used when present)
  city: ["city", "location.city"],
  country: ["country", "location.country"],
  lat: ["lat", "latitude", "location.lat"],
  lng: ["lng", "lon", "longitude", "location.lng"],
  description: ["description", "short_description"],
  amenities: ["amenities", "featured_amenities"],
  // pricing
  price: ["price", "discountedPrice", "discounted_price", "finalPrice", "final_price"],
  originalPrice: ["originalPrice", "original_price", "strikePrice", "strike_price"],
  taxesAndFees: ["taxesAndFees", "taxes_and_fees", "taxes"],
  freeCancellation: ["freeCancellation", "free_cancellation", "isFreeCancellation"],
  currency: ["currency"],
} as const;

type Field = keyof typeof FIELDS;

/** Seen on the rendered results page — reported when missing. */
const EXPECTED: Field[] = [
  "id", "name", "propertyType", "starRating", "reviewScore", "reviewLabel", "reviewCount",
  "neighborhood", "distanceFromCenter", "coverImage", "price", "originalPrice",
  "taxesAndFees", "freeCancellation",
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
  currency: string;
  /** City/country of the searched place, used when a listing doesn't carry its own. */
  city?: string | null;
  country?: string | null;
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

  const tags = [
    propertyType && slugTag(propertyType),
    stars && stars > 0 ? `${stars}-star` : null,
    reviewLabel && slugTag(reviewLabel),
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
      nearest_airport: null,
    },
    tags: [...new Set(tags)],
    description_short: toStr(get("description"))?.slice(0, 300) ?? null,
    amenities: Array.isArray(amenities)
      ? amenities.map((a: any) => toStr(a?.name ?? a)).filter((a): a is string => !!a)
      : [],
    rating: reviewScore || null,
    cover_image_url: coverUrl,
    url: rawUrl
      ? /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://www.cuddlynest.com/${rawUrl.replace(/^\/+/, "")}`
      : `https://www.cuddlynest.com/hotel/-${id}`,
  };

  const distance = get("distanceFromCenter");
  return {
    ...stay,
    details: {
      neighborhood: toStr(get("neighborhood")),
      distanceFromCenterKm: toNumber(distance),
      reviewCount,
    },
    pricing: {
      price: toNumber(get("price")),
      originalPrice: toNumber(get("originalPrice")),
      taxesAndFees: toNumber(get("taxesAndFees")),
      freeCancellation: toBool(get("freeCancellation")),
      currency: toStr(get("currency")) ?? ctx.currency,
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
    const body = buildAvailabilityBody(req, place);
    const json = await callAvailability(body);

    // Local inspection aid: save the raw response when asked to (never in production).
    const captureFile = process.env.CUDDLYNEST_BE_CAPTURE_FILE;
    if (captureFile) {
      try {
        writeFileSync(captureFile, JSON.stringify(json, null, 2));
      } catch {
        /* best effort */
      }
    }

    const { stays, report } = mapAvailabilityResponse(json, {
      checkin: req.checkin,
      checkout: req.checkout,
      currency: req.currency,
      city: place.city ?? place.name ?? null,
      country: place.country ?? null,
    });
    req.log?.(
      report.mapped && !Object.keys(report.missingExpected).length ? "info" : "warn",
      "Availability response mapping",
      { summary: summarizeReport(report) },
    );

    // The mapping above uses ASSUMED field names (simulated fixture only). Until
    // it's been checked against a real response, don't hand its output to callers.
    if (!MAPPING_VERIFIED) {
      throw new BeApiError(
        "response_mapping_pending",
        `Availability API answered, but the response mapping hasn't been verified against ` +
          `a real response yet (${summarizeReport(report)}).`,
      );
    }

    return {
      resolvedLocation: { location: body.location, lat: body.lat, lng: body.lng, locationType: place.type },
      stays,
    };
  },
};
