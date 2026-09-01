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
  buildRoomGroupsSessionId,
  buildDestinationSlug,
  fetchStaticListing,
  resolveDestinations,
  getAccessToken,
  shapeUnit,
  OPEN_QUESTIONS,
} from "./cuddlynest.js";
import {
  fetchRoomsAndPricing,
  buildSearchFrame,
  CUDDLYNEST_WS_BASE,
  CUDDLYNEST_ACCESS_TOKEN,
} from "./rooms-ws.js";

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
  description:
    "Resolve a destination on CuddlyNest (city / area) to its candidates via the " +
    "autosuggestion API, including the internal slug used for pricing lookups. " +
    "NOTE: enumerating the hotels in a destination (with prices) needs a further " +
    "capture — for live room prices on a known hotel use cuddlynest_listing_details.",
  inputSchema: {
    type: "object",
    properties: {
      destination: {
        type: "string",
        description: "Destination to search (city / area), e.g. 'Santa Marta, Colombia'.",
      },
      ...GUEST_PROPS,
    },
    required: ["destination"],
  },
};

const CUDDLYNEST_LISTING_DETAILS_TOOL: Tool = {
  name: "cuddlynest_listing_details",
  description:
    "Get details for a specific CuddlyNest hotel: static basics (name, location, " +
    "description, amenities, images) from the listing page, plus live room options, " +
    "prices, availability and cancellation policies streamed from CuddlyNest's " +
    "wholesale-supplier WebSocket (accumulated across partial messages).",
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
      destinationSlug: {
        type: "string",
        description:
          "CuddlyNest internal destination slug for the hotel's city (e.g. " +
          "'SantaMartaMagdalenaColombia'). Optional — derived from the listing page's " +
          "city/state/country when omitted.",
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
    robotsTxtContent = await response.text();
    log("info", "Successfully fetched robots.txt");
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
    params.children != null
      ? parseInt(String(params.children), 10)
      : childAges.length || 0;
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
async function handleSearch(params: any) {
  const { destination } = params;
  const g = normalizeGuests(params);

  if (!destination) {
    return textResult({ error: "Provide `destination`." }, true);
  }

  let candidates;
  try {
    candidates = await resolveDestinations(destination);
  } catch (e) {
    return textResult(
      { error: `Autosuggestion lookup failed: ${e instanceof Error ? e.message : String(e)}` },
      true,
    );
  }

  return textResult({
    query: destination,
    guests: g,
    candidates,
    note:
      candidates.length === 0
        ? "No destination candidates returned."
        : "Destination(s) resolved. Enumerating the hotels in a destination (with " +
          "prices) needs a further capture — CuddlyNest's destination-level search " +
          "protocol has not been captured. For a specific hotel, call " +
          "cuddlynest_listing_details with its URL or product_id.",
    openQuestions: OPEN_QUESTIONS,
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

  // --- Static basics (Cheerio) --------------------------------------------
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
          "Static listing parse is degraded: no schema.org Hotel block found. Only " +
            "meta-tag basics were extracted; city/state/country may be missing, which " +
            "would leave the destination slug empty. Pass `destinationSlug` explicitly " +
            "or map the CuddlyNest hotel-page DOM (fetchStaticListing() in cuddlynest.ts).",
        );
      }
    } catch (e) {
      staticError = e instanceof Error ? e.message : String(e);
    }
  }

  // --- Destination slug --------------------------------------------------
  let destinationSlug: string = params.destinationSlug || "";
  if (!destinationSlug && staticListing) {
    destinationSlug = buildDestinationSlug(
      staticListing.city,
      staticListing.state,
      staticListing.country,
    );
  }
  if (!destinationSlug) {
    notes.push(
      "Could not determine a destination slug (no `destinationSlug` param and the " +
        "listing page did not yield city/state/country). The pricing request may " +
        "return nothing.",
    );
  }

  // --- Live rooms + pricing (WebSocket) --------------------------------
  let rooms: any = null;
  let roomsError: string | undefined;
  if (!g.checkin || !g.checkout) {
    roomsError =
      "checkin and checkout (YYYY-MM-DD) are required to fetch room prices and availability.";
  } else {
    const sessionid = buildRoomGroupsSessionId({
      destinationSlug,
      hotelProductId: productId,
      checkin: g.checkin,
      checkout: g.checkout,
      adults: g.adults,
      children: g.children,
      infants: g.infants,
      rooms: g.rooms,
      currency: g.currency,
      propertyType: "Hotel",
    });
    log("info", "Built room_groups sessionid", { sessionid });

    const { token, source, note: tokenNote } = await getAccessToken(
      CUDDLYNEST_ACCESS_TOKEN || undefined,
      hotelUrl,
      log,
    );

    if (!token) {
      roomsError = tokenNote;
    } else {
      notes.push(`Access token source: ${source}.`);
      const locationParts = [
        staticListing?.city,
        staticListing?.state,
        staticListing?.country,
      ].filter(Boolean);
      const frame = buildSearchFrame({
        sessionid,
        productId,
        checkin: g.checkin,
        checkout: g.checkout,
        currency: g.currency,
        adults: g.adults,
        children: g.children,
        infants: g.infants,
        rooms: g.rooms,
        childAges: g.childAges,
        location: locationParts.join(", "),
        locationType: "Hotel",
      });

      const result = await fetchRoomsAndPricing(
        { sessionid, frame, currency: g.currency, accessToken: token },
        { log },
      );

      if (result.status === "error" && result.unitDetails.length === 0) {
        roomsError = result.note || "WebSocket request failed.";
      } else {
        rooms = {
          status: result.status,
          sessionid: result.sessionid,
          filters: result.filters,
          partnersSeen: result.partnersSeen,
          messagesReceived: result.messageCount,
          units: result.unitDetails.map((u) => shapeUnit(u, g.currency)),
        };
        if (result.status !== "complete") {
          notes.push(
            `Room stream ended as "${result.status}" (no terminal frame seen before ` +
              `timeout) — results may be incomplete.`,
          );
        }
      }
    }
  }

  return textResult({
    productId,
    hotelUrl,
    destinationSlug: destinationSlug || null,
    guests: g,
    staticListing,
    staticError,
    rooms,
    roomsError,
    notes,
    openQuestions: OPEN_QUESTIONS,
  });
}

// ---------------------------------------------------------------------------
// Server setup (generic scaffolding, unchanged shape)
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "cuddlynest", version: VERSION },
  { capabilities: { tools: {} } },
);

function log(level: "info" | "warn" | "error", message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (data) console.error(`${logMessage}:`, JSON.stringify(data, null, 2));
  else console.error(logMessage);
}

log("info", "CuddlyNest MCP Server starting", {
  version: VERSION,
  ignoreRobotsTxt: IGNORE_ROBOTS_TXT,
  wsBase: CUDDLYNEST_WS_BASE,
  accessTokenSupplied: !!CUDDLYNEST_ACCESS_TOKEN,
  nodeVersion: process.version,
  platform: process.platform,
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: CUDDLYNEST_TOOLS,
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
      arguments: request.params.arguments,
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
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
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

async function runServer() {
  try {
    await fetchRobotsTxt();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("info", "CuddlyNest MCP Server running on stdio", {
      version: VERSION,
      robotsRespected: !IGNORE_ROBOTS_TXT,
    });
    process.on("SIGINT", () => {
      log("info", "Received SIGINT, shutting down gracefully");
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      log("info", "Received SIGTERM, shutting down gracefully");
      process.exit(0);
    });
  } catch (error) {
    log("error", "Failed to start server", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

runServer().catch((error) => {
  log("error", "Fatal error running server", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
