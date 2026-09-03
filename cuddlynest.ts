// CuddlyNest-specific helpers that don't need a browser:
//   - parsing a hotel URL / product_id
//   - the static listing page (schema.org ld+json / OG tags) for the non-priced
//     basics: name, location, description, amenities, images
//   - destination autosuggestion (public, no auth)
//   - shaping scraped room offers into a compact tool result
//
// Room prices/availability come from scrape-listing.ts (a real headless-browser
// read of the public listing page). Nothing here talks to CuddlyNest's private
// WebSocket or auth endpoints.

import fetch from "node-fetch";
import * as cheerio from "cheerio";
import type { RoomOffer } from "./scrape-listing.js";

export const BASE_URL = "https://www.cuddlynest.com";
export const AUTOSUGGEST_URL = "https://autosuggestion-2-0.cuddlynest.com/";
export const PRODUCT_DETAIL_URL =
  "https://ldp-2-0-product-details.cuddlynest.com/api/v1/productDetail";
export const GEOPAGE_URL = "https://discovery-pages.cuddlynest.com/fetch_geopage";

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
// Destination autosuggestion (public, no auth)
// ---------------------------------------------------------------------------

let regionNames: Intl.DisplayNames | undefined;
/** Expand a bare 2-letter ISO country code to its English name ("CO" -> "Colombia"). */
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

export interface DestinationCandidate {
  name?: string;
  city?: string;
  state?: string;
  country?: string;
  slug?: string; // the autosuggestion API's own slug, e.g. "santa-marta"
  type?: string; // "City" | "POI" | "Airport" | "Region" | "State" | "Country"
  lat?: number;
  lon?: number;
  propertyCount?: number;
}

export interface HotelCandidate {
  productId: string;
  name?: string;
  url: string; // full https listing URL
  slug?: string;
  propertyType?: string; // "Hotel" | "VR" | ...
  starRating?: number;
  guestRating?: number; // out of 10
  guestRatingText?: string; // "Exceptional", "Very Good", ...
  reviewCount?: number;
  images?: string[]; // only when sourced from the geo page
  distanceFromCenterKm?: number; // only from geo page
  featuredAmenities?: string[]; // only from geo page
  source: "autosuggest" | "geopage";
}

// Raw autosuggestion rows (keeps `_id`, which encodes the row type).
async function fetchAutosuggest(query: string): Promise<any[]> {
  const url = `${AUTOSUGGEST_URL}?s=${encodeURIComponent(query)}&city=&state=&country=`;
  try {
    const arr = JSON.parse(await httpGet(url, "application/json"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

const HOTEL_ROW = /^HOTEL(\d+)$/i;

/** Places only (cities, POIs, airports, regions) — hotel rows are filtered out. */
export async function resolveDestinations(query: string): Promise<DestinationCandidate[]> {
  const rows = await fetchAutosuggest(query);
  return rows
    .filter((row) => !HOTEL_ROW.test(String(row?._id ?? "")))
    .map((row) => row?._source ?? row)
    .filter(Boolean)
    .map((s: any) => ({
      name: s.name,
      city: s.city || undefined,
      state: s.state || undefined,
      country: normalizeCountry(s.country || undefined),
      slug: s.slug || undefined,
      type: s.type,
      lat: s.location?.lat,
      lon: s.location?.lon,
      propertyCount: s.property_count,
    }));
}

function autosuggestRowToHotel(row: any): HotelCandidate | null {
  const m = String(row?._id ?? "").match(HOTEL_ROW);
  if (!m) return null;
  const s = row._source ?? {};
  const productId = m[1];
  const slug = s.slug || undefined;
  return {
    productId,
    name: s.name,
    url: `${BASE_URL}/hotel/${slug ? `${slug}-${productId}` : `-${productId}`}`,
    slug,
    propertyType: s.type,
    starRating: Number(s.star_rating) || undefined,
    guestRating: Number(s.grs_new) || undefined,
    guestRatingText: s.grs_adjective_new || undefined,
    source: "autosuggest",
  };
}

/**
 * Hotels for a free-text query, from the public autosuggestion API. It's
 * autocomplete-scale (~7-18 top matches), not a full listing — CuddlyNest's
 * full results page (`/sr/…`) is bot-blocked and disallowed by robots.txt.
 * Fires the plain query and the query + " hotel" and merges.
 */
export async function searchHotels(query: string): Promise<HotelCandidate[]> {
  const [a, b] = await Promise.all([
    fetchAutosuggest(query),
    fetchAutosuggest(`${query} hotel`),
  ]);
  const byId = new Map<string, HotelCandidate>();
  for (const row of [...a, ...b]) {
    const h = autosuggestRowToHotel(row);
    if (h && !byId.has(h.productId)) byId.set(h.productId, h);
  }
  return [...byId.values()];
}

/**
 * Best-effort: a hotel's product-detail breadcrumbs sometimes carry the city's
 * geo-page id (`ct…`) as a `/l/<slug>-ct<digits>` URL. Returns it or null.
 */
export async function resolveCityGeoId(productId: string): Promise<string | null> {
  try {
    const j = JSON.parse(
      await httpGet(
        `${PRODUCT_DETAIL_URL}?product_id=${encodeURIComponent(productId)}&currency=USD`,
        "application/json",
      ),
    );
    const crumbs: any[] = j?.data?.breadcrumbs ?? [];
    for (const c of crumbs) {
      const m = String(c?.url ?? "").match(/\/l\/[^/]*?-(ct\d+)/i);
      if (m) return m[1];
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * The public geo-page bootstrap API — up to ~60 hotels for a city, grouped by
 * theme; we flatten and de-duplicate. Needs the `ct…` id from resolveCityGeoId().
 */
export interface GeopageResult {
  hotels: HotelCandidate[];
  cityLabel?: string;
  city?: string;
  state?: string;
  country?: string;
  propertyCount?: number;
}

export async function fetchGeopageHotels(geoId: string): Promise<GeopageResult> {
  const j = JSON.parse(await httpGet(`${GEOPAGE_URL}/${encodeURIComponent(geoId)}`, "application/json"));
  const data = j?.data;
  const sections = data?.sections_data;
  if (!sections || typeof sections !== "object") return { hotels: [] };

  const byId = new Map<string, HotelCandidate>();
  for (const arr of Object.values(sections) as any[][]) {
    for (const h of arr ?? []) {
      const productId = String(h?.product_id ?? "");
      if (!productId || byId.has(productId)) continue;
      const slug = String(h?.url ?? "").match(/([a-z0-9-]+)-\d+$/i)?.[1];
      byId.set(productId, {
        productId,
        name: h?.product_title,
        url: h?.url ? `${BASE_URL}/${String(h.url).replace(/^\//, "")}` : `${BASE_URL}/hotel/-${productId}`,
        slug,
        propertyType: h?.property_type,
        starRating: Number(h?.star_rating) || undefined,
        guestRating: Number(h?.grs_new) || undefined,
        guestRatingText: h?.grs_adjective_new || undefined,
        reviewCount: Number(String(h?.grs_total_reviews ?? "").replace(/\D/g, "")) || undefined,
        images: Array.isArray(h?.product_images) ? h.product_images.slice(0, 4) : undefined,
        distanceFromCenterKm:
          h?.distance != null && h?.distance_unit === "km" ? Number(h.distance) || undefined : undefined,
        featuredAmenities: Array.isArray(h?.featured_amenities)
          ? h.featured_amenities.map((a: any) => a?.name).filter(Boolean)
          : undefined,
        source: "geopage",
      });
    }
  }
  const meta = data?.bootstrap_data?.meta_data ?? {};
  return {
    hotels: [...byId.values()],
    cityLabel: meta.searchString || undefined,
    city: meta.city || undefined,
    state: meta.state || undefined,
    country: normalizeCountry(meta.country || undefined),
    propertyCount: meta.property_count != null ? Number(meta.property_count) : undefined,
  };
}

/**
 * Pick the place candidate that best fits the raw query. The autosuggest API
 * ranks by fuzzy score, so "Cartagena, Colombia" can surface Cartagena, Chile
 * first — here we prefer the candidate whose country / state / name actually
 * appear in what the user typed, then the one with the most properties.
 */
export function pickAnchorPlace(
  query: string,
  places: DestinationCandidate[],
): DestinationCandidate | undefined {
  if (places.length === 0) return undefined;
  const norm = (x?: string) => (x || "").toLowerCase().replace(/[^a-z]/g, "");
  const q = norm(query);
  const isPlace = (p: DestinationCandidate) => /city|region|state|country/i.test(p.type || "");
  const score = (p: DestinationCandidate) => {
    let s = 0;
    if (p.country && q.includes(norm(p.country))) s += 3;
    if (p.state && q.includes(norm(p.state))) s += 2;
    if ((p.name || p.city) && q.includes(norm(p.name || p.city))) s += 2;
    if (isPlace(p)) s += 1;
    s += Math.min((p.propertyCount ?? 0) / 500, 2);
    return s;
  };
  return [...places].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Is this geo page for the place the user asked about? Accepts if the geo page's
 * city appears in the raw query, else falls back to matching the resolved anchor
 * (country must agree, city must overlap). A weak/empty anchor doesn't veto.
 */
export function geopageMatchesPlace(
  gp: GeopageResult,
  place: DestinationCandidate | undefined,
  query = "",
): boolean {
  const norm = (x?: string) => (x || "").toLowerCase().replace(/[^a-z]/g, "");
  const gpCity = norm(gp.city);

  // Strongest signal: the user typed the geo page's city.
  if (gpCity && norm(query).includes(gpCity)) return true;

  if (!place) return true;
  const country = norm(place.country);
  if (country && norm(gp.country) && country !== norm(gp.country)) return false;
  const placeCity = norm(place.city || place.name);
  if (placeCity && gpCity && !gpCity.includes(placeCity) && !placeCity.includes(gpCity)) {
    return false;
  }
  return true;
}

/**
 * Merge autosuggest + geopage hotel lists. Geopage rows are city-verified, so
 * they win on both data and ordering; autosuggest-only rows (which the fuzzy API
 * sometimes pulls from the wrong place) fall to the back.
 */
export function mergeHotelCandidates(
  autosuggest: HotelCandidate[],
  geopage: HotelCandidate[],
): HotelCandidate[] {
  const byId = new Map<string, HotelCandidate>();
  for (const h of autosuggest) byId.set(h.productId, h);
  for (const h of geopage) {
    const prev = byId.get(h.productId);
    byId.set(h.productId, prev ? { ...prev, ...h } : h);
  }
  const rank = (h: HotelCandidate) => (h.source === "geopage" ? 0 : 1);
  return [...byId.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.guestRating ?? 0) - (a.guestRating ?? 0) ||
      (b.starRating ?? 0) - (a.starRating ?? 0),
  );
}

// ---------------------------------------------------------------------------
// Static listing page (Cheerio) — non-priced basics
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
 * Best-effort extraction of the static, non-priced listing basics. Reads
 * schema.org ld+json and Open Graph / meta tags. `degraded: true` when no
 * Hotel block is found.
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
  cancellationPolicyType?: string;
  cancellationPolicyText?: string[];
  priceBreakdown?: any;
  roomFilters: string[];
}

/** A scraped RoomOffer -> compact shape for the tool result. */
export function shapeUnit(u: RoomOffer, requestedCurrency: string): ShapedUnit {
  return {
    title: u?.title ?? "Room",
    partnerName: u?.partner_name ?? "unknown",
    unitPrice: Number(u?.unit_price ?? u?.price_breakdown?.total?.amount ?? 0),
    currency: requestedCurrency,
    remainingRooms: Number(u?.remaining_rooms ?? 0),
    guests: u?.guests != null ? Number(u.guests) : undefined,
    cancellationPolicyType: u?.cancellation_policy?.type,
    cancellationPolicyText: Array.isArray(u?.cancellation_policy?.text)
      ? u.cancellation_policy.text
      : undefined,
    priceBreakdown: u?.price_breakdown,
    roomFilters: Array.isArray(u?.room_filters) ? u.room_filters : [],
  };
}
