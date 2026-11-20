#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import robotsParser from "robots-parser";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import {
  BASE_URL,
  parseHotelInput,
  fetchStaticListing,
  shapeUnit,
} from "./cuddlynest.js";
import { DbError, getStaysCached, startStaysCacheRefresh } from "./db.js";
import { parseDestination } from "./destination.js";
import { fallbackSearchProvider, type Vertical } from "./fallback-provider.js";
import { BeApiError, beApiSearchProvider } from "./be-api-provider.js";
import {
  AttractionsError,
  getCachedAttractions,
  searchAttractions,
  startAttractionsCacheRefresh,
} from "./attractions-provider.js";
import { FlightsError, getCachedFlights, searchFlights, type FlightsRequest } from "./flights-provider.js";
import {
  BookingError,
  getStayBookingStatus,
  isBookingEnabled,
  requestToBook,
} from "./booking.js";
import { attractionCheckout, checkAttractionAvailability, getAttractionOptions } from "./attractions-booking.js";
import { checkoutFlight, priceFlight } from "./flights-booking.js";
import { appendFileSync, mkdirSync } from "fs";
import { resolveListingPath, scrapeListing } from "./scrape-listing.js";

// ---------------------------------------------------------------------------
// Version (generic scaffolding, unchanged)
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
    return process.env.MCP_SERVER_VERSION || packageJson.version || "unknown";
  } catch {
    return process.env.MCP_SERVER_VERSION || "unknown";
  }
}

const VERSION = getVersion();
const SCRAPE_TIMEOUT_MS = parseInt(process.env.CUDDLYNEST_SCRAPE_TIMEOUT_MS || "35000", 10);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const GUEST_PROPS = {
  checkin: { type: "string", description: "Check-in date (YYYY-MM-DD)" },
  checkout: { type: "string", description: "Check-out date (YYYY-MM-DD)" },
  adults: { type: "number", description: "Number of adults (default: 2)" },
  children: {
    type: "number",
    description: "Number of children (default: 0, or derived from childAges)",
  },
  childAges: {
    type: "array",
    items: { type: "number" },
    description: "Age of each child at check-in, e.g. [2, 7]. Sets `children` when given.",
  },
  infants: { type: "number", description: "Number of infants (default: 0)" },
  rooms: { type: "number", description: "Number of rooms (default: 1)" },
  currency: {
    type: "string",
    description: "ISO 4217 currency code for prices (default: USD), e.g. USD, EUR, COP",
  },
} as const;

const CUDDLYNEST_SEARCH_TOOL: Tool = {
  name: "cuddlynest_search",
  title: "Search CuddlyNest hotels",
  annotations: {
    title: "Search CuddlyNest hotels",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description:
    "Search CuddlyNest for a destination (\"City\", \"City, Country\", \"City, State\" or " +
    "\"City, State, Country\") and the top stays there. By default static data only " +
    "(no prices or availability). When CuddlyNest's catalog DB/cache serves it " +
    "(source: \"db\", with cachedAt) it returns `stays` — name, category, city/country, coordinates, " +
    "nearest airport, tags, short description, guest rating, cover image and URL. " +
    "If the catalog can't answer, it returns place candidates and a `hotels` list " +
    "from the public site. Only an explicit source: \"live\" queries real-time availability " +
    "(prices under each stay's `pricing`). Pass a stay's id / product_id to cuddlynest_listing_details " +
    "for live rooms and prices. Results are top-matches scale, not the full inventory.",
  inputSchema: {
    type: "object",
    properties: {
      destination: {
        type: "string",
        description: "Destination to search (city / area), e.g. 'Santa Marta, Colombia'.",
      },
      hotelsOnly: {
        type: "boolean",
        description: "Return only the hotel list, skipping place candidates (default false).",
      },
      fullCityList: {
        type: "boolean",
        description:
          "Also pull the broader city hotel list (~60) from the geo-page API when it " +
          "can be resolved — a couple of extra requests. Default true.",
      },
      limit: {
        type: "number",
        description: "Max stays to return from the catalog DB (default 20, max 50).",
      },
      vertical: {
        type: "string",
        enum: ["stays", "flights", "attractions"],
        description:
          "What to search (default \"stays\"). Attractions and flights: \"auto\"/\"db\" " +
          "answer from a short-lived cache of earlier live searches; \"live\" for real-time " +
          "results. Attractions: tours and activities with a from-price. Flights: " +
          "live fares from `origin` to `destination`; checkin = departure date, checkout = " +
          "return date (omit for one way); childAges required when travelling with children.",
      },
      origin: {
        type: "string",
        description: "Flights only: departure city or IATA code, e.g. 'Bogotá' or 'BOG'.",
      },
      cabinClass: {
        type: "string",
        enum: ["economy", "premium_economy", "business", "first"],
        description: "Flights only (default economy).",
      },
      source: {
        type: "string",
        enum: ["auto", "db", "live"],
        description:
          "Where to read stays from. \"auto\" (default): catalog DB/cache, falling back to " +
          "the public site if the DB fails, has no results, or the destination is " +
          "ambiguous. \"db\": catalog DB/cache only — returns an error instead of falling " +
          "back. \"live\": CuddlyNest's live availability API only (real-time supplier " +
          "prices; needs checkin/checkout). Use \"live\" only when live prices are really " +
          "needed — it never falls back to another source.",
      },
      ...GUEST_PROPS,
    },
    required: ["destination"],
  },
};

const CUDDLYNEST_LISTING_DETAILS_TOOL: Tool = {
  name: "cuddlynest_listing_details",
  title: "Get CuddlyNest hotel rooms & prices",
  annotations: {
    title: "Get CuddlyNest hotel rooms & prices",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description:
    "Get details for a specific CuddlyNest hotel: static basics (name, location, " +
    "description, amenities, images) from the listing page, plus room options, " +
    "prices, availability and cancellation policies read from the public listing " +
    "page rendered in a headless browser.",
  inputSchema: {
    type: "object",
    properties: {
      hotel: {
        type: "string",
        description:
          "CuddlyNest hotel URL or numeric product_id. The product_id is the trailing " +
          "number in a listing URL, e.g. " +
          "https://www.cuddlynest.com/hotel/us/le-meridien-boston-cambridge-4264955 -> 4264955.",
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt for the listing-page fetch on this request.",
      },
      ...GUEST_PROPS,
    },
    required: ["hotel"],
  },
};

const CUDDLYNEST_TOOLS = [CUDDLYNEST_SEARCH_TOOL, CUDDLYNEST_LISTING_DETAILS_TOOL] as const;

// ---------------------------------------------------------------------------
// Booking tools. Hidden unless CUDDLYNEST_ENABLE_BOOKING_TOOLS=true. Request to
// Book starts the supplier pre-book, a live call (L2B): these tools are only for
// an explicit booking flow, never for recommendations.
// ---------------------------------------------------------------------------
const BOOKING_CHECKOUT_TOOL: Tool = {
  name: "cuddlynest_booking_checkout",
  title: "Get the CuddlyNest checkout link",
  annotations: { title: "Get the CuddlyNest checkout link", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  description:
    "Book a stay: creates the booking request for one room rate and returns the CuddlyNest " +
    "checkout link, the final price (with taxes and fees) and the cancellation policy. Pass one " +
    "entry of `bookingOptions[].offer` from cuddlynest_listing_details (same dates and guests). " +
    "Only call it when the user has chosen that rate and wants to book. The user enters their " +
    "details and pays on the checkout page; never ask the user for card details.",
  inputSchema: {
    type: "object",
    properties: {
      offer: {
        type: "object",
        description: "A bookingOptions[].offer from cuddlynest_listing_details, unchanged.",
        properties: {
          productId: { type: "string" },
          roomId: { type: "string" },
          recordId: { type: "string" },
          redisKey: { type: "string" },
          roomRedisKey: { type: "string" },
        },
        required: ["productId", "roomId"],
      },
      ...GUEST_PROPS,
    },
    required: ["offer", "checkin", "checkout"],
  },
};

const BOOKING_STATUS_TOOL: Tool = {
  name: "cuddlynest_booking_status",
  title: "Check a CuddlyNest booking",
  annotations: { title: "Check a CuddlyNest booking", readOnlyHint: true, openWorldHint: true },
  description:
    "Status of a stay booked through cuddlynest_booking_checkout: pending (not paid yet), booked, " +
    "cancelled or declined. Needs both enquiryId and bookingReference from that step.",
  inputSchema: {
    type: "object",
    properties: {
      enquiryId: { type: "string", description: "enquiryId from cuddlynest_booking_checkout." },
      bookingReference: { type: "string", description: "bookingReference from cuddlynest_booking_checkout." },
    },
    required: ["enquiryId", "bookingReference"],
  },
};

// Attractions (AO-83) and flights (AO-84) booking steps. Same gating as above;
// availability and price are live supplier calls (L2B).
const ATTRACTION_REF_PROPS = {
  activityId: { type: "string", description: "The attraction's id from a cuddlynest_search attractions result." },
  packageId: { type: "string", description: "packageId from cuddlynest_attraction_options." },
} as const;

const ATTRACTION_OPTIONS_TOOL: Tool = {
  name: "cuddlynest_attraction_options",
  title: "CuddlyNest attraction options",
  annotations: { title: "CuddlyNest attraction options", readOnlyHint: true, openWorldHint: true },
  description:
    "Step 1 of booking an attraction. Packages, ticket types (adult, child...) with prices, and start " +
    "times for a date. Cached prices: no supplier call and nothing is reserved.",
  inputSchema: {
    type: "object",
    properties: {
      activityId: ATTRACTION_REF_PROPS.activityId,
      date: { type: "string", description: "YYYY-MM-DD" },
    },
    required: ["activityId", "date"],
  },
};

const ATTRACTION_AVAILABILITY_TOOL: Tool = {
  name: "cuddlynest_attraction_availability",
  title: "Check a CuddlyNest attraction's availability",
  annotations: {
    title: "Check a CuddlyNest attraction's availability",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description:
    "Step 2 of booking an attraction. Checks live with the supplier that the chosen tickets are " +
    "available on the date and time, and returns the confirmed total, a sessionId and the CuddlyNest " +
    "checkoutUrl where the user pays (valid ~15 minutes). Only call it " +
    "once the user has chosen the package, tickets and time and wants to book. If it answers " +
    "available: false, offer the availableTimes / suggestions it returns.",
  inputSchema: {
    type: "object",
    properties: {
      ...ATTRACTION_REF_PROPS,
      date: { type: "string", description: "YYYY-MM-DD" },
      time: { type: "string", description: "HH:MM, one of the package's times. Omit for open-date tickets." },
      tickets: {
        type: "array",
        description: "Ticket types and how many of each.",
        items: {
          type: "object",
          properties: {
            skuId: { type: "string" },
            count: { type: "integer", minimum: 1 },
            type: { type: "string", description: "The ticket's type from the options step (adult, child...)." },
          },
          required: ["skuId", "count"],
        },
      },
      supplier: { type: "string", description: "The package's supplier from the options step." },
    },
    required: ["activityId", "packageId", "date", "tickets"],
  },
};

const ATTRACTION_CHECKOUT_TOOL: Tool = {
  name: "cuddlynest_attraction_checkout",
  title: "CuddlyNest attraction checkout",
  annotations: { title: "CuddlyNest attraction checkout", readOnlyHint: true, openWorldHint: true },
  description:
    "Step 3 of booking an attraction. Final price with fees, cancellation policy and the details " +
    "each traveler must give, for a sessionId from the availability check. Nothing is booked or " +
    "charged. Payment happens on CuddlyNest; never ask the user for card details.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      ...ATTRACTION_REF_PROPS,
      currency: { type: "string", description: "ISO 4217, default USD." },
    },
    required: ["sessionId", "activityId", "packageId"],
  },
};

const FLIGHT_REF_PROPS = {
  sessionId: { type: "string", description: "sessionId of a cuddlynest_search flights result with source \"live\"." },
  flightId: { type: "string", description: "The flight's id in that result." },
  currency: { type: "string", description: "ISO 4217, default USD." },
} as const;

const FLIGHT_PRICE_TOOL: Tool = {
  name: "cuddlynest_flight_price",
  title: "Confirm a CuddlyNest flight price",
  annotations: { title: "Confirm a CuddlyNest flight price", readOnlyHint: true, openWorldHint: true },
  description:
    "Step 1 of booking a flight. Re-prices the chosen flight live with the airline/supplier: final " +
    "total with taxes and fees, fare rules and baggage. Only call it once the user has chosen this " +
    "flight and wants to book. If the price went up or the flight was substituted, tell the user.",
  inputSchema: { type: "object", properties: FLIGHT_REF_PROPS, required: ["sessionId", "flightId"] },
};

const FLIGHT_CHECKOUT_TOOL: Tool = {
  name: "cuddlynest_flight_checkout",
  title: "Hold a CuddlyNest flight booking",
  annotations: {
    title: "Hold a CuddlyNest flight booking",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  description:
    "Step 2 of booking a flight. Re-checks the price and creates a pending booking with the " +
    "passengers' details (names exactly as on their travel documents). Nothing is charged and no " +
    "ticket is issued. Only call it after cuddlynest_flight_price and once the user confirmed the " +
    "price and gave the details. Never ask for card details.",
  inputSchema: {
    type: "object",
    properties: {
      ...FLIGHT_REF_PROPS,
      passengers: {
        type: "array",
        description: "One entry per traveler, the same counts as the search.",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["adult", "child", "infant"] },
            title: { type: "string", enum: ["mr", "mrs", "ms", "miss", "dr", "master"] },
            firstName: { type: "string" },
            lastName: { type: "string" },
            gender: { type: "string", enum: ["m", "f", "o"] },
            dateOfBirth: { type: "string", description: "YYYY-MM-DD" },
            nationality: { type: "string", description: "ISO alpha-2, e.g. CO" },
            document: {
              type: "object",
              description: "Travel document, when the route needs one.",
              properties: {
                type: { type: "string", description: "e.g. passport" },
                number: { type: "string" },
                issuingCountry: { type: "string", description: "ISO alpha-2" },
                expiryDate: { type: "string", description: "YYYY-MM-DD" },
              },
              required: ["type", "number", "issuingCountry", "expiryDate"],
            },
          },
          required: ["type", "title", "firstName", "lastName", "gender", "dateOfBirth", "nationality"],
        },
      },
      contact: {
        type: "object",
        properties: {
          email: { type: "string" },
          phoneCountryCode: { type: "string", description: "e.g. +57" },
          phoneNumber: { type: "string" },
          address: {
            type: "object",
            properties: {
              street: { type: "string" },
              city: { type: "string" },
              state: { type: "string" },
              postalCode: { type: "string" },
              country: { type: "string", description: "ISO alpha-2" },
            },
            required: ["street", "city", "state", "postalCode", "country"],
          },
        },
        required: ["email", "phoneCountryCode", "phoneNumber", "address"],
      },
    },
    required: ["sessionId", "flightId", "passengers", "contact"],
  },
};

const BOOKING_TOOLS = [
  BOOKING_CHECKOUT_TOOL,
  BOOKING_STATUS_TOOL,
  ATTRACTION_OPTIONS_TOOL,
  ATTRACTION_AVAILABILITY_TOOL,
  ATTRACTION_CHECKOUT_TOOL,
  FLIGHT_PRICE_TOOL,
  FLIGHT_CHECKOUT_TOOL,
] as const;
const BOOKING_TOOL_NAMES = new Set<string>(BOOKING_TOOLS.map((t) => t.name));

function listedTools() {
  return isBookingEnabled() ? [...CUDDLYNEST_TOOLS, ...BOOKING_TOOLS] : CUDDLYNEST_TOOLS;
}

// ---------------------------------------------------------------------------
// robots.txt handling (generic scaffolding, repointed at cuddlynest.com)
// ---------------------------------------------------------------------------
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const IGNORE_ROBOTS_TXT =
  process.env.IGNORE_ROBOTS_TXT === "true" ||
  process.argv.slice(2).includes("--ignore-robots-txt");

const robotsErrorMessage =
  "This path is disallowed by CuddlyNest's robots.txt for this User-agent. " +
  "You may want to run the server with '--ignore-robots-txt'.";
let robotsTxtContent = "";

async function fetchRobotsTxt() {
  if (IGNORE_ROBOTS_TXT) {
    log("info", "Skipping robots.txt fetch (ignored by configuration)");
    return;
  }
  try {
    log("info", "Fetching robots.txt from CuddlyNest");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`${BASE_URL}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const body = await response.text();
    // Some datacenter IPs get a Cloudflare/anti-bot HTML interstitial served in
    // place of robots.txt; robots-parser reads that as "disallow everything".
    // A real robots.txt is plain text with directive lines — reject anything
    // that looks like HTML or carries no recognizable directive.
    const looksLikeHtml = /<!doctype html|<html[\s>]|<head[\s>]|<script[\s>]/i.test(body);
    const hasDirectives = /^\s*(user-agent|disallow|allow|sitemap)\s*:/im.test(body);
    if (looksLikeHtml || !hasDirectives) {
      log("warn", "robots.txt response is not a valid robots file (interstitial?); assuming all paths allowed");
      robotsTxtContent = "";
    } else {
      robotsTxtContent = body;
      log("info", "Successfully fetched robots.txt");
    }
  } catch (error) {
    log("warn", "Error fetching robots.txt, assuming all paths allowed", {
      error: error instanceof Error ? error.message : String(error),
    });
    robotsTxtContent = "";
  }
}

function isPathAllowed(path: string): boolean {
  if (!robotsTxtContent) return true;
  try {
    const robots = robotsParser(`${BASE_URL}/robots.txt`, robotsTxtContent);
    const allowed = robots.isAllowed(path, USER_AGENT);
    if (!allowed) log("warn", "Path disallowed by robots.txt", { path });
    return allowed;
  } catch (error) {
    log("warn", "Error parsing robots.txt, allowing path", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

function normalizeGuests(params: any) {
  const childAges: number[] = Array.isArray(params.childAges)
    ? params.childAges.map((a: any) => parseInt(String(a), 10)).filter((n: number) => !Number.isNaN(n))
    : [];
  const children =
    params.children != null ? parseInt(String(params.children), 10) : childAges.length || 0;
  return {
    checkin: params.checkin as string | undefined,
    checkout: params.checkout as string | undefined,
    adults: parseInt(String(params.adults ?? 2), 10),
    children,
    childAges,
    infants: parseInt(String(params.infants ?? 0), 10),
    rooms: parseInt(String(params.rooms ?? 1), 10),
    currency: String(params.currency ?? "USD").trim(),
  };
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------
const VERTICALS: readonly Vertical[] = ["stays", "flights", "attractions"];

/** Attractions / flights cache miss on "auto" / "db": no API call, no fallback. */
function notCached(destination: string, vertical: Vertical, mode: string) {
  log("info", "Cache miss, no live call", { vertical, destination, requestedSource: mode });
  return textResult({
    query: destination,
    vertical,
    requestedSource: mode,
    source: "unavailable",
    reason: `${vertical}_not_cached`,
    results: [],
    note:
      `No cached ${vertical} for this search (the cache is filled by live searches). ` +
      `Search with source "live" for real-time results.`,
  });
}

async function handleFlightsSearch(destination: string, params: any, mode: string) {
  const g = normalizeGuests({ ...params, adults: params.adults ?? 1 });
  const live = mode === "live";
  try {
    if (g.children > g.childAges.length) {
      throw new FlightsError("invalid_input", "Flights need the age of each child: pass `childAges`.");
    }
    const req: FlightsRequest = {
      origin: String(params.origin ?? ""),
      destination,
      departureDate: g.checkin,
      returnDate: g.checkout,
      adults: g.adults,
      childAges: g.childAges,
      infants: g.infants,
      cabinClass: params.cabinClass,
      currency: g.currency,
      limit: params.limit,
      log,
    };
    const r = live ? await searchFlights(req) : getCachedFlights(req);
    if (!r) return notCached(destination, "flights", mode);
    return textResult({
      query: destination,
      vertical: "flights",
      source: live ? "live" : "cache",
      cachedAt: r.cachedAt,
      provider: "flight-search-engine",
      route: r.route,
      sessionId: r.sessionId,
      status: r.status,
      totalCount: r.totalCount,
      flightCount: r.flights.length,
      flights: r.flights,
      note:
        `${r.flights.length} itinerary(ies), best first. Times are local to each airport; ` +
        `prices are customer totals for all passengers and only appear under \`pricing\`.` +
        (live ? "" : ` Cached fares from ${r.cachedAt}: indicative only, confirm with source "live" before booking.`),
    });
  } catch (e) {
    // No fallback: there is no other flights source.
    const code = e instanceof FlightsError ? e.code : "unexpected_error";
    log("warn", "Flight search failed", { destination, code, requestedSource: mode });
    return textResult(
      {
        query: destination,
        vertical: "flights",
        source: live ? "live" : "cache",
        error: e instanceof Error ? e.message : String(e),
        liveErrorCode: code,
      },
      true,
    );
  }
}

async function handleAttractionsSearch(destination: string, limit: number | undefined, mode: string) {
  const live = mode === "live";
  try {
    const r = live ? await searchAttractions({ destination, limit, log }) : getCachedAttractions(destination, limit);
    if (!r) return notCached(destination, "attractions", mode);
    return textResult({
      query: destination,
      vertical: "attractions",
      source: live ? "live" : "cache",
      cachedAt: r.cachedAt,
      provider: "attractions-shopping-service",
      resolvedLocation: r.resolvedLocation,
      totalCount: r.totalCount,
      attractionCount: r.attractions.length,
      attractions: r.attractions,
      note:
        `${r.attractions.length} attraction(s). Prices are "from" prices for ` +
        `pricing.date and only appear under each attraction's \`pricing\`; ratings are 0-5.` +
        (live ? "" : ` Cached from ${r.cachedAt}; use source "live" for current prices.`),
    });
  } catch (e) {
    // No fallback: there is no other attractions source.
    const code = e instanceof AttractionsError ? e.code : "unexpected_error";
    log("warn", "Attractions search failed", { destination, code });
    return textResult(
      {
        query: destination,
        vertical: "attractions",
        source: "live",
        error: e instanceof Error ? e.message : String(e),
        liveErrorCode: code,
      },
      true,
    );
  }
}

async function handleLiveSearch(
  destination: string,
  g: ReturnType<typeof normalizeGuests>,
  limit?: number,
) {
  const provider = beApiSearchProvider.name;
  try {
    const r = await beApiSearchProvider.searchStays({ destination, ...g, log });
    const max = Math.min(Math.max(1, Math.floor(limit ?? 20)), 50);
    const stays = r.stays.slice(0, max);
    return textResult({
      query: destination,
      source: "live",
      provider,
      resolvedLocation: r.resolvedLocation,
      guests: g,
      stayCount: stays.length,
      stays,
      note:
        `${stays.length} stay(s) with live supplier availability. Static fields match the ` +
        `catalog shape; prices and availability are only under each stay's \`pricing\`.`,
    });
  } catch (e) {
    // No silent fallback: the caller asked for live data specifically.
    const code = e instanceof BeApiError ? e.code : "unexpected_error";
    log("warn", "Live availability search failed", { destination, code });
    return textResult(
      {
        query: destination,
        source: "live",
        provider,
        error: e instanceof Error ? e.message : String(e),
        liveErrorCode: code,
      },
      true,
    );
  }
}

async function handleSearch(params: any) {
  const { destination } = params;
  const g = normalizeGuests(params);
  const hotelsOnly = params.hotelsOnly === true;
  const fullCityList = params.fullCityList !== false;

  if (!destination) return textResult({ error: "Provide `destination`." }, true);

  const mode = params.source ?? "auto";
  if (!["auto", "db", "live"].includes(mode)) {
    return textResult({ error: `Invalid source "${mode}". Use "auto", "db" or "live".` }, true);
  }
  const vertical = params.vertical ?? "stays";
  if (!VERTICALS.includes(vertical)) {
    return textResult(
      { error: `Invalid vertical "${vertical}". Use ${VERTICALS.map((v) => `"${v}"`).join(", ")}.` },
      true,
    );
  }
  // Attractions and flights (AO-9 / AO-10): "auto" / "db" read the MCP's cache
  // only; the API (a supplier call for flights, possibly for attractions) is only
  // reached with an explicit "live" (L2B), never as an automatic fallback.
  if (vertical === "attractions") return handleAttractionsSearch(String(destination), params.limit, mode);
  if (vertical === "flights") return handleFlightsSearch(String(destination), params, mode);

  // Explicit "live" only (Option B): a real-time supplier call, which counts
  // against the Look-to-Book ratio. Never reached from "auto" or "db".
  if (mode === "live") return handleLiveSearch(String(destination), g, params.limit);

  let dbFallbackReason: string | undefined;
  if (mode !== "live") {
    const parsed = parseDestination(String(destination));
    let message: string | undefined;
    if (parsed.kind === "ambiguous") {
      dbFallbackReason = "ambiguous_destination";
      message = parsed.reason;
    } else {
      const matched = { city: parsed.city, state: parsed.state, country: parsed.country };
      try {
        const r = await getStaysCached({ ...matched, cacheKey: parsed.key, limit: params.limit });
        if (r.stays.length > 0 || mode === "db") {
          return textResult({
            query: destination,
            source: "db",
            matched,
            cache: r.cache,
            cachedAt: r.cachedAt,
            stayCount: r.stays.length,
            stays: r.stays,
            note: r.stays.length
              ? `${r.stays.length} stay(s) from CuddlyNest's catalog (data as of ${r.cachedAt}). ` +
                `Static data only — no prices or availability. Pass a stay's id to ` +
                `cuddlynest_listing_details for live rooms and prices.`
              : `No published stays in the catalog for ${JSON.stringify(matched)}. Try ` +
                `source "auto" or "live", or a different spelling of the destination.`,
          });
        }
        dbFallbackReason = "no_results";
      } catch (e) {
        dbFallbackReason = e instanceof DbError ? e.code : "query_failed";
        message = e instanceof Error ? e.message : String(e);
      }
    }

    if (mode === "db") {
      return textResult(
        {
          query: destination,
          source: "db",
          error: `Catalog DB search failed: ${dbFallbackReason}${message ? ` — ${message}` : ""}`,
          code: dbFallbackReason,
        },
        true,
      );
    }
    logDbFallback({ destination: String(destination), code: dbFallbackReason!, message });
  }


  let live;
  try {
    live = await fallbackSearchProvider.searchStays({
      destination: String(destination),
      fullCityList,
      log,
    });
  } catch (e) {
    return textResult({ error: e instanceof Error ? e.message : String(e) }, true);
  }
  const { places, city, hotelSource, hotels } = live;

  return textResult({
    query: destination,
    source: "live",
    provider: fallbackSearchProvider.name,
    dbFallbackReason,
    guests: g,
    ...(hotelsOnly ? {} : { places }),
    city,
    hotelSource,
    hotelCount: hotels.length,
    hotels,
    note:
      hotels.length === 0
        ? "No hotels matched. Try a more specific destination, or pass a hotel URL / " +
          "product_id straight to cuddlynest_listing_details."
        : `${hotels.length} hotel(s). This is a top-matches list, not full inventory ` +
          `(CuddlyNest's full results page is not machine-accessible). Pass any ` +
          `hotel's product_id to cuddlynest_listing_details for live rooms and prices.`,
  });
}

async function handleListingDetails(params: any) {
  const g = normalizeGuests(params);

  let productId: string;
  let sourceUrl: string | undefined;
  try {
    ({ productId, sourceUrl } = parseHotelInput(params.hotel));
  } catch (e) {
    return textResult({ error: e instanceof Error ? e.message : String(e) }, true);
  }

  const hotelUrl = sourceUrl || `${BASE_URL}/hotel/-${productId}`;
  const notes: string[] = [];

  // --- Static basics (Cheerio) ------------------------------------------
  let staticListing: any = null;
  let staticError: string | undefined;
  const path = new URL(hotelUrl).pathname;
  if (!params.ignoreRobotsText && !isPathAllowed(path)) {
    staticError = robotsErrorMessage;
  } else {
    try {
      staticListing = await fetchStaticListing(productId, sourceUrl);
      if (staticListing?.degraded) {
        notes.push(
          "Static listing parse is degraded: no schema.org Hotel block found; only " +
            "meta-tag basics were extracted.",
        );
      }
    } catch (e) {
      staticError = e instanceof Error ? e.message : String(e);
    }
  }

  // --- Rooms + pricing (headless browser, public page) ---------------
  let rooms: any = null;
  let roomsError: string | undefined;
  if (!g.checkin || !g.checkout) {
    roomsError =
      "checkin and checkout (YYYY-MM-DD) are required to read room prices and availability.";
  } else {
    try {
      const listingPath = await resolveListingPath(productId);
      const result = await scrapeListing(
        {
          productId,
          listingPath,
          checkin: g.checkin,
          checkout: g.checkout,
          adults: g.adults,
          children: g.children,
          childrenAges: g.childAges,
          infants: g.infants,
          rooms: g.rooms,
          currency: g.currency,
        },
        { timeoutMs: SCRAPE_TIMEOUT_MS, log },
      );
      const units = result.rooms.map((u) => shapeUnit(u, g.currency, isBookingEnabled()));
      rooms = {
        listingUrl: result.url,
        // "From <price>" header off the page when present; otherwise the cheapest
        // extracted unit (the header uses a fragile selector — see scrape-listing.ts).
        fromPriceText: result.fromPriceText,
        fromPrice: units.length ? Math.min(...units.map((u) => u.unitPrice)) : null,
        currency: g.currency,
        scrapedAt: result.scrapedAt,
        partnersSeen: [...new Set(units.map((u) => u.partnerName))],
        units,
      };
      if (result.rooms.length === 0) {
        notes.push(
          "The listing page rendered but no room offers were extracted. Either the " +
            "page did not finish loading in time (raise CUDDLYNEST_SCRAPE_TIMEOUT_MS) " +
            "or CuddlyNest's frontend prop shape changed — see extractRoomsFromDom() " +
            "in scrape-listing.ts.",
        );
      }
    } catch (e) {
      roomsError = e instanceof Error ? e.message : String(e);
    }
  }

  return textResult({
    productId,
    hotelUrl,
    guests: g,
    staticListing,
    staticError,
    rooms,
    roomsError,
    notes,
  });
}

/** Tool arguments safe for logs: passenger and contact details are masked. */
function loggableArguments(args: any) {
  if (!args || typeof args !== "object") return args;
  if (!args.passengers && !args.contact) return args;
  return {
    ...args,
    ...(args.passengers ? { passengers: Array.isArray(args.passengers) ? args.passengers.length : "***" } : {}),
    ...(args.contact ? { contact: "***" } : {}),
  };
}

async function handleBooking(name: string, params: any) {
  try {
    switch (name) {
      case "cuddlynest_booking_checkout": {
        const g = normalizeGuests(params);
        const o = params.offer ?? {};
        const opt = (v: unknown) => (v == null || v === "" ? undefined : String(v));
        const r = await requestToBook(
          {
            productId: String(o.productId ?? ""),
            roomId: String(o.roomId ?? ""),
            recordId: opt(o.recordId),
            redisKey: opt(o.redisKey),
            roomRedisKey: opt(o.roomRedisKey),
          },
          {
            checkin: String(g.checkin ?? ""),
            checkout: String(g.checkout ?? ""),
            adults: g.adults,
            children: g.children,
            childAges: g.childAges,
            infants: g.infants,
            rooms: g.rooms,
            currency: g.currency.toUpperCase(),
          },
          { log },
        );
        return textResult({
          vertical: "stays",
          step: "checkout",
          ...r,
          payment: { status: "handoff", method: "cuddlynest_checkout" },
          note:
            "Show the user price.total and the cancellation policy, then send them to checkoutUrl to " +
            "enter their details and pay. Keep enquiryId and bookingReference to check the status later.",
        });
      }
      case "cuddlynest_booking_status":
        return textResult({
          vertical: "stays",
          step: "status",
          ...(await getStayBookingStatus(String(params.enquiryId ?? ""), String(params.bookingReference ?? ""))),
        });
      case "cuddlynest_attraction_options":
        return textResult({
          vertical: "attractions",
          step: "options",
          ...(await getAttractionOptions(String(params.activityId ?? ""), String(params.date ?? ""), log)),
          note: "Prices are per ticket from cache. Next, once the user picked: cuddlynest_attraction_availability.",
        });
      case "cuddlynest_attraction_availability": {
        const r = await checkAttractionAvailability({
          activityId: String(params.activityId ?? ""),
          packageId: String(params.packageId ?? ""),
          date: String(params.date ?? ""),
          time: params.time ? String(params.time) : undefined,
          tickets: Array.isArray(params.tickets)
            ? params.tickets.map((t: any) => ({
                skuId: String(t?.skuId ?? ""),
                count: Number(t?.count),
                ...(t?.type ? { type: String(t.type) } : {}),
              }))
            : [],
          supplier: params.supplier ? String(params.supplier) : undefined,
          log,
        });
        return textResult({
          vertical: "attractions",
          step: "availability",
          ...r,
          note: r.available
            ? "Available. Show the total, then send the user to checkoutUrl to enter traveler details and pay " +
              "(within ~15 minutes). cuddlynest_attraction_checkout previews fees and traveler fields."
            : "Not available as requested: offer the user the alternatives returned.",
        });
      }
      case "cuddlynest_attraction_checkout":
        return textResult({
          vertical: "attractions",
          step: "checkout",
          ...(await attractionCheckout({
            sessionId: String(params.sessionId ?? ""),
            activityId: String(params.activityId ?? ""),
            packageId: String(params.packageId ?? ""),
            currency: String(params.currency ?? "USD").toUpperCase(),
            log,
          })),
        });
      case "cuddlynest_flight_price": {
        const r = await priceFlight({
          sessionId: String(params.sessionId ?? ""),
          flightId: String(params.flightId ?? ""),
          currency: String(params.currency ?? "USD").toUpperCase(),
          log,
        });
        return textResult({
          vertical: "flights",
          step: "price",
          ...r,
          note:
            r.substituted || r.priceChange?.requiresAcceptance
              ? "The flight or its price changed: tell the user and get their OK before cuddlynest_flight_checkout."
              : "Price confirmed. Next, with the passengers' details: cuddlynest_flight_checkout.",
        });
      }
      case "cuddlynest_flight_checkout":
        return textResult({
          vertical: "flights",
          step: "checkout",
          ...(await checkoutFlight({
            sessionId: String(params.sessionId ?? ""),
            flightId: String(params.flightId ?? ""),
            currency: String(params.currency ?? "USD").toUpperCase(),
            passengers: Array.isArray(params.passengers) ? params.passengers : [],
            contact: params.contact ?? {},
            log,
          })),
        });
    }
    return textResult({ error: `Unknown booking tool ${name}` }, true);
  } catch (e) {
    const code = e instanceof BookingError ? e.code : "provider_error";
    log("warn", "Booking step failed", { tool: name, code });
    return textResult(
      {
        error: e instanceof Error ? e.message : String(e),
        bookingErrorCode: code,
        ...(e instanceof BookingError && e.details ? { details: e.details } : {}),
      },
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// Server setup (generic scaffolding, unchanged shape)
// ---------------------------------------------------------------------------
function log(level: "info" | "warn" | "error", message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (data) console.error(`${logMessage}:`, JSON.stringify(data, null, 2));
  else console.error(logMessage);
}

const FALLBACK_LOG =
  process.env.CUDDLYNEST_FALLBACK_LOG || join(__dirname, "..", "logs", "db-fallback.log");
let fallbackLogWarned = false;

function logDbFallback(entry: { destination: string; code: string; message?: string }) {
  const record = { ts: new Date().toISOString(), event: "db_fallback", ...entry };
  console.error(JSON.stringify(record));
  try {
    mkdirSync(dirname(FALLBACK_LOG), { recursive: true });
    appendFileSync(FALLBACK_LOG, JSON.stringify(record) + "\n");
  } catch (e) {
    if (!fallbackLogWarned) {
      fallbackLogWarned = true;
      log("warn", "Could not write the DB fallback log file; stderr only", {
        error: (e as any)?.code ?? String(e),
      });
    }
  }
}

log("info", "CuddlyNest MCP Server starting", {
  version: VERSION,
  ignoreRobotsTxt: IGNORE_ROBOTS_TXT,
  scrapeTimeoutMs: SCRAPE_TIMEOUT_MS,
  nodeVersion: process.version,
  platform: process.platform,
});

// One MCP server instance with both tool handlers attached. stdio mode reuses a
// single instance; HTTP mode builds a fresh one per request (stateless).
function createMcpServer(): Server {
  const server = new Server(
    { name: "cuddlynest", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listedTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const startTime = Date.now();
  try {
    if (!request.params.name) {
      throw new McpError(ErrorCode.InvalidParams, "Tool name is required");
    }
    if (!request.params.arguments) {
      throw new McpError(ErrorCode.InvalidParams, "Tool arguments are required");
    }

    log("info", "Tool call received", {
      tool: request.params.name,
      arguments: loggableArguments(request.params.arguments),
    });

    if (!robotsTxtContent && !IGNORE_ROBOTS_TXT) {
      await fetchRobotsTxt();
    }

    let result;
    switch (request.params.name) {
      case "cuddlynest_search":
        result = await handleSearch(request.params.arguments);
        break;
      case "cuddlynest_listing_details":
        result = await handleListingDetails(request.params.arguments);
        break;
      default:
        if (!isBookingEnabled() || !BOOKING_TOOL_NAMES.has(request.params.name)) {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
        result = await handleBooking(request.params.name, request.params.arguments);
    }

    log("info", "Tool call completed", {
      tool: request.params.name,
      duration: `${Date.now() - startTime}ms`,
      success: !result.isError,
    });
    return result;
  } catch (error) {
    log("error", "Tool call failed", {
      tool: request.params.name,
      duration: `${Date.now() - startTime}ms`,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof McpError) throw error;
    return textResult(
      {
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      },
      true,
    );
  }
  });

  return server;
}

function installSignalHandlers() {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log("info", `Received ${sig}, shutting down gracefully`);
      process.exit(0);
    });
  }
}

// --- stdio (default) -------------------------------------------------------
async function runStdio() {
  await fetchRobotsTxt();
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  log("info", "CuddlyNest MCP Server running on stdio", {
    version: VERSION,
    robotsRespected: !IGNORE_ROBOTS_TXT,
  });
  installSignalHandlers();
}

// --- Streamable HTTP (opt-in: --http / MCP_TRANSPORT=http / PORT set) ------
// Stateless: a fresh MCP server + transport per POST, per the SDK guidance, so
// concurrent clients can't collide on request ids. Read-only, no sessions.
async function runHttp(port: number) {
  const { createServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  await fetchRobotsTxt();

  // Optional shared-secret gate for a public deployment. Off unless set.
  const authToken = process.env.MCP_AUTH_TOKEN || "";

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: "cuddlynest", version: VERSION }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    if (req.method !== "POST") {
      // Stateless server: no SSE stream to GET, nothing to DELETE.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    if (authToken) {
      const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (got !== authToken) {
        res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
        return;
      }
    }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
      return;
    }

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log("error", "HTTP request failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    }
  });

  const refresh = startStaysCacheRefresh(log);
  const attractionsRefresh = startAttractionsCacheRefresh(log);

  http.listen(port, () => {
    log("info", "CuddlyNest MCP Server running on Streamable HTTP", {
      version: VERSION,
      endpoint: `http://localhost:${port}/mcp`,
      auth: authToken ? "bearer token required" : "open",
      cacheRefresh: refresh ? `every ${refresh.intervalMs / 3_600_000}h` : "off",
      attractionsCacheRefresh: attractionsRefresh ? `every ${attractionsRefresh.intervalMs / 3_600_000}h` : "off",
      robotsRespected: !IGNORE_ROBOTS_TXT,
    });
  });
  installSignalHandlers();
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const httpMode =
      args.includes("--http") ||
      process.env.MCP_TRANSPORT === "http" ||
      (!!process.env.PORT && process.env.MCP_TRANSPORT !== "stdio");
    if (httpMode) {
      const flagIdx = args.indexOf("--http");
      const port = Number(
        (flagIdx >= 0 && args[flagIdx + 1] && !args[flagIdx + 1].startsWith("-") && args[flagIdx + 1]) ||
          process.env.PORT ||
          8080,
      );
      await runHttp(port);
    } else {
      await runStdio();
    }
  } catch (error) {
    log("error", "Failed to start server", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

main().catch((error) => {
  log("error", "Fatal error running server", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
