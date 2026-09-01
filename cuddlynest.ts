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
  type?: string;
  lat?: number;
  lon?: number;
  propertyCount?: number;
}

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
      country: normalizeCountry(s.country || undefined),
      slug: s.slug || undefined,
      type: s.type,
      lat: s.location?.lat,
      lon: s.location?.lon,
      propertyCount: s.property_count,
    }));
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
