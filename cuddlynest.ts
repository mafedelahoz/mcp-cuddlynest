// CuddlyNest-specific request/response plumbing.
//
// Unlike the Airbnb server this repo was seeded from, CuddlyNest does NOT serve
// pricing or room availability in its static HTML, and it is not a plain REST/XHR
// call either. Live room + price data arrives over a WebSocket as a stream of
// `Connection.Message` events (see rooms-ws.ts). The static HTML is still useful
// for the non-priced basics (name, location, description, amenities, images) and
// for the city/state/country used to build the destination slug.
//
// This module owns:
//   - parsing a CuddlyNest hotel URL / product_id into the canonical product_id
//   - building the `sessionid` string + destination slug the WS layer keys on
//   - fetching + parsing the static listing page with Cheerio
//   - resolving a destination string via CuddlyNest's autosuggestion API
//   - obtaining the anonymous app access token the WS endpoint requires
//   - shaping the accumulated unit_details into a compact tool result

import fetch from "node-fetch";
import * as cheerio from "cheerio";

export const BASE_URL = "https://www.cuddlynest.com";
export const AUTOSUGGEST_URL = "https://autosuggestion-2-0.cuddlynest.com/";
export const JWT_ISSUER = "https://jwt-issuer.cuddlynest.com";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Hotel URL / product_id parsing
// ---------------------------------------------------------------------------

// A CuddlyNest listing URL ends in the numeric product_id, e.g.
//   https://www.cuddlynest.com/hotel/us/le-meridien-boston-cambridge-4264955
//   -> product_id 4264955
export function parseHotelInput(hotelUrlOrId: string): { productId: string; sourceUrl?: string } {
  const raw = String(hotelUrlOrId).trim();

  if (/^\d+$/.test(raw)) return { productId: raw };

  const match = raw.match(/-(\d+)(?:[/?#]|$)/);
  if (match) {
    const sourceUrl = /^https?:\/\//i.test(raw) ? raw : undefined;
    return { productId: match[1], sourceUrl };
  }

  const trailing = raw.match(/(\d+)\s*$/);
  if (trailing) return { productId: trailing[1] };

  throw new Error(
    `Could not extract a CuddlyNest product_id from "${hotelUrlOrId}". ` +
      `Pass either the numeric id or a listing URL ending in "-<id>" ` +
      `(e.g. https://www.cuddlynest.com/hotel/us/some-hotel-4264955).`,
  );
}

// ---------------------------------------------------------------------------
// Destination slug
// ---------------------------------------------------------------------------

let regionNames: Intl.DisplayNames | undefined;
/**
 * Expand a 2-letter ISO country code to its English name ("CO" -> "Colombia").
 * The listing page's schema.org address carries the ISO code, but the sessionid
 * slug is built from the full country name ("...MagdalenaColombia"). Anything
 * that isn't a bare 2-letter code is returned unchanged.
 */
export function normalizeCountry(country?: string): string | undefined {
  if (!country) return country;
  if (!/^[A-Za-z]{2}$/.test(country.trim())) return country;
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(country.trim().toUpperCase()) || country;
  } catch {
    return country;
  }
}

/**
 * The destination component of the sessionid is built CLIENT-SIDE by
 * concatenating name + state + country with no separators and stripping every
 * non-alphanumeric character. It is NOT the `slug` field the autosuggestion API
 * returns (that one is "santa-marta").
 *
 *   ("Santa Marta", "Magdalena", "Colombia") -> "SantaMartaMagdalenaColombia"
 *
 * Confirmed against a live capture. A 2-letter country code is expanded first
 * (the listing page gives "CO", the slug wants "Colombia").
 */
export function buildDestinationSlug(name?: string, state?: string, country?: string): string {
  return [name, state, normalizeCountry(country)]
    .filter(Boolean)
    .join("")
    .replace(/[^A-Za-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// sessionid construction
// ---------------------------------------------------------------------------

export interface RoomGroupsSessionParams {
  /** e.g. "SantaMartaMagdalenaColombia" — see buildDestinationSlug(). Required
   *  (the client always sends a non-empty slug, even on a direct hotel deep-link). */
  destinationSlug: string;
  hotelProductId: string;
  checkin: string; // YYYY-MM-DD
  checkout: string; // YYYY-MM-DD
  adults: number;
  children: number;
  infants: number;
  rooms: number;
  currency: string; // ISO 4217, e.g. "COP", "USD"
  propertyType?: string; // observed: "Hotel"
}

/**
 * Build the `room_groups_` sessionid the WebSocket layer uses to correlate a
 * request with its streamed `Connection.Message` responses.
 *
 *   room_groups_ : {destination_slug} : {children} : {infants} : {adults}
 *                : {rooms} : {property_type} : viewport : {currency}
 *                : {hotel_product_id} : {checkin} : {checkout} : {currency_lowercase}
 *
 *   room_groups_:SantaMartaMagdalenaColombia:0:0:2:1:Hotel:viewport:COP:4395541:2026-10-05:2026-10-08:cop
 *
 * Field order children:infants:adults:rooms confirmed by a live A/B capture.
 */
export function buildRoomGroupsSessionId(p: RoomGroupsSessionParams): string {
  const propertyType = p.propertyType || "Hotel";
  return [
    "room_groups_",
    p.destinationSlug,
    p.children,
    p.infants,
    p.adults,
    p.rooms,
    propertyType,
    "viewport",
    p.currency.toUpperCase(),
    p.hotelProductId,
    p.checkin,
    p.checkout,
    p.currency.toLowerCase(),
  ].join(":");
}

// Remaining soft spots, surfaced in every tool response.
export const OPEN_QUESTIONS = [
  "ACCESS TOKEN: the anonymous app JWT for the pricing WebSocket is minted in-browser " +
    "at bootstrap and is NOT present in the server-rendered HTML (scrape confirmed empty). " +
    "Until the token-issuance call (issuer https://jwt-issuer.cuddlynest.com) is captured, " +
    "supply a token via CUDDLYNEST_ACCESS_TOKEN / --access-token (it lasts ~1h).",
  "The WS wire frame is built from the payload the page hands its Web Worker; it has " +
    "not been confirmed byte-for-byte on the wire (that happens inside the Worker).",
  "Destination-level hotel enumeration (search with prices) is not captured — " +
    "cuddlynest_search only resolves the destination + slug.",
];

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function httpGet(url: string, accept: string, timeout = 30000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: accept,
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Anonymous app access token
// ---------------------------------------------------------------------------

interface DecodedJwt {
  header: any;
  payload: any;
  expSeconds?: number;
}

export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = (s: string) =>
      Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const header = JSON.parse(b64(parts[0]));
    const payload = JSON.parse(b64(parts[1]));
    return { header, payload, expSeconds: typeof payload.exp === "number" ? payload.exp : undefined };
  } catch {
    return null;
  }
}

export function jwtIsFresh(token: string, skewSeconds = 60): boolean {
  const decoded = decodeJwt(token);
  if (!decoded?.expSeconds) return false;
  return decoded.expSeconds - skewSeconds > Date.now() / 1000;
}

/**
 * Get the anonymous app token the WS endpoint wants in `?access_token=`.
 *
 * 1. explicit token (env/arg) if still fresh
 * 2. scrape a fresh RS256 JWT issued by jwt-issuer.cuddlynest.com out of a
 *    CuddlyNest page's HTML/JSON (best effort — the token is embedded at bootstrap)
 * 3. null -> caller surfaces a needs_capture for the token-issuance call
 */
export async function getAccessToken(
  explicit: string | undefined,
  pageUrl: string,
  log: (l: "info" | "warn" | "error", m: string, d?: any) => void = () => {},
): Promise<{ token: string | null; source: "explicit" | "scraped" | "none"; note?: string }> {
  if (explicit && jwtIsFresh(explicit)) return { token: explicit, source: "explicit" };
  if (explicit && !jwtIsFresh(explicit)) {
    log("warn", "Supplied CUDDLYNEST_ACCESS_TOKEN is expired or unparseable; trying to scrape one");
  }

  try {
    const html = await httpGet(
      pageUrl,
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    );
    // RS256 JWTs start with the base64url of {"alg":"RS256"...
    const candidates = html.match(/eyJhbGciOiJS[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
    for (const c of candidates) {
      const decoded = decodeJwt(c);
      if (
        decoded?.payload?.iss === JWT_ISSUER &&
        decoded.header?.alg === "RS256" &&
        jwtIsFresh(c)
      ) {
        log("info", "Scraped a fresh app access token from page HTML", {
          exp: decoded.expSeconds,
          sub: decoded.payload?.sub,
        });
        return { token: c, source: "scraped" };
      }
    }
    log("warn", "No fresh jwt-issuer.cuddlynest.com token found in page HTML", {
      candidatesSeen: candidates.length,
    });
  } catch (e) {
    log("warn", "Token scrape failed", { error: e instanceof Error ? e.message : String(e) });
  }

  return {
    token: null,
    source: "none",
    note:
      "Could not obtain a CuddlyNest app access token. Supply one via " +
      "CUDDLYNEST_ACCESS_TOKEN (env) / --access-token, or capture the token-issuance " +
      `call fired during page bootstrap (issuer ${JWT_ISSUER}).`,
  };
}

// ---------------------------------------------------------------------------
// Destination autosuggestion
// ---------------------------------------------------------------------------

export interface DestinationCandidate {
  name?: string;
  city?: string;
  state?: string;
  country?: string;
  autosuggestSlug?: string; // the API's own "slug" — NOT the sessionid slug
  sessionidSlug: string; // what buildRoomGroupsSessionId() wants
  type?: string;
  lat?: number;
  lon?: number;
  propertyCount?: number;
}

/**
 * Resolve a free-text destination via CuddlyNest's autosuggestion API
 * (no auth). Returns candidates newest→best as the API orders them, each with
 * the client-side-built `sessionidSlug`.
 */
export async function resolveDestinations(query: string): Promise<DestinationCandidate[]> {
  const url = `${AUTOSUGGEST_URL}?s=${encodeURIComponent(query)}&city=&state=&country=`;
  const body = await httpGet(url, "application/json");
  let arr: any[];
  try {
    arr = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((row) => row?._source ?? row)
    .filter(Boolean)
    .map((s: any) => ({
      name: s.name,
      city: s.city || undefined,
      state: s.state || undefined,
      country: s.country || undefined,
      autosuggestSlug: s.slug || undefined,
      sessionidSlug: buildDestinationSlug(s.name, s.state, s.country),
      type: s.type,
      lat: s.location?.lat,
      lon: s.location?.lon,
      propertyCount: s.property_count,
    }));
}

// ---------------------------------------------------------------------------
// Static listing page (Cheerio) — non-priced basics + location parts
// ---------------------------------------------------------------------------

export interface StaticListing {
  productId: string;
  url: string;
  name?: string;
  description?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  starRating?: number;
  images: string[];
  amenities: string[];
  jsonLd: any[];
  /** True when no schema.org Hotel block was found — only meta-tag basics filled. */
  degraded: boolean;
}

/**
 * Best-effort extraction of the static, non-priced listing basics + the
 * city/state/country needed to build the destination slug.
 *
 * ⚠️ The exact DOM of a CuddlyNest hotel page is not fully mapped. This reads the
 * portable things a hotel page exposes: schema.org ld+json, Open Graph / meta
 * tags. When none is found, `degraded: true`.
 */
export async function fetchStaticListing(
  productId: string,
  hotelUrl?: string,
): Promise<StaticListing> {
  const url = hotelUrl || `${BASE_URL}/hotel/-${productId}`;
  const html = await httpGet(
    url,
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  );
  const $ = cheerio.load(html);

  const jsonLd: any[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    if (!txt) return;
    try {
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed)) jsonLd.push(...parsed);
      else jsonLd.push(parsed);
    } catch {
      /* ignore malformed ld+json */
    }
  });

  const meta = (name: string) =>
    $(`meta[property="${name}"]`).attr("content") ||
    $(`meta[name="${name}"]`).attr("content") ||
    undefined;

  const hotelNode = jsonLd.find((n) =>
    /hotel|lodgingbusiness|resort|bedandbreakfast/i.test(String(n?.["@type"])),
  );

  const images = new Set<string>();
  const ogImage = meta("og:image");
  if (ogImage) images.add(ogImage);
  const ldImages = hotelNode?.image;
  if (typeof ldImages === "string") images.add(ldImages);
  else if (Array.isArray(ldImages))
    ldImages.forEach((i: any) => images.add(typeof i === "string" ? i : i?.url));

  const amenities: string[] = [];
  const amenityFeature = hotelNode?.amenityFeature;
  if (Array.isArray(amenityFeature)) {
    for (const a of amenityFeature) {
      const n = a?.name || a?.value;
      if (n) amenities.push(String(n));
    }
  }

  const addr = hotelNode?.address;
  const addrObj = typeof addr === "object" && addr !== null ? addr : undefined;
  const address =
    typeof addr === "string"
      ? addr
      : addrObj
        ? [
            addrObj.streetAddress,
            addrObj.addressLocality,
            addrObj.addressRegion,
            addrObj.addressCountry,
            addrObj.postalCode,
          ]
            .filter(Boolean)
            .join(", ")
        : undefined;

  const geo = hotelNode?.geo;
  const degraded = !hotelNode;

  return {
    productId,
    url,
    name: hotelNode?.name || meta("og:title") || $("title").first().text().trim() || undefined,
    description: hotelNode?.description || meta("og:description") || meta("description"),
    address,
    city: addrObj?.addressLocality || undefined,
    state: addrObj?.addressRegion || undefined,
    country: normalizeCountry(
      (typeof addrObj?.addressCountry === "object"
        ? addrObj?.addressCountry?.name
        : addrObj?.addressCountry) || undefined,
    ),
    latitude: geo?.latitude != null ? Number(geo.latitude) : undefined,
    longitude: geo?.longitude != null ? Number(geo.longitude) : undefined,
    starRating:
      hotelNode?.starRating?.ratingValue != null
        ? Number(hotelNode.starRating.ratingValue)
        : undefined,
    images: [...images].filter(Boolean) as string[],
    amenities,
    jsonLd,
    degraded,
  };
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

export interface ShapedUnit {
  title: string;
  partnerName: string;
  unitPrice: number;
  currency: string;
  remainingRooms: number;
  guests?: number;
  roomSize?: string;
  cancellationPolicyType?: string;
  cancellationPolicyText?: string[];
  priceBreakdown?: any;
  amenities: string[];
  images: string[];
  availableRoomGroups: string[];
}

export function shapeUnit(u: any, fallbackCurrency: string): ShapedUnit {
  const cpCurrency =
    u?.cancellation_policy?.partner_cp?.[0]?.currency ||
    u?.price_breakdown?.total?.currency ||
    fallbackCurrency;
  return {
    title: u?.title ?? u?.old_title ?? "Room",
    partnerName: u?.partner_name ?? "unknown",
    unitPrice: Number(u?.unit_price ?? u?.price_breakdown?.total?.amount ?? 0),
    currency: cpCurrency,
    remainingRooms: Number(u?.remaining_rooms ?? 0),
    guests: u?.guests != null ? Number(u.guests) : undefined,
    roomSize:
      u?.room_size && u?.room_size_unit ? `${u.room_size} ${u.room_size_unit}` : undefined,
    cancellationPolicyType: u?.cancellation_policy_type ?? u?.cancellation_policy?.type,
    cancellationPolicyText: Array.isArray(u?.cancellation_policy?.text)
      ? u.cancellation_policy.text
      : undefined,
    priceBreakdown: u?.price_breakdown,
    amenities: Array.isArray(u?.amenities)
      ? u.amenities.map((a: any) => a?.name).filter(Boolean)
      : [],
    images: Array.isArray(u?.images) ? u.images : [],
    availableRoomGroups: u?.room_groups ? Object.keys(u.room_groups) : [],
  };
}
