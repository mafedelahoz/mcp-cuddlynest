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
  resolveDestinations,
  shapeUnit,
} from "./cuddlynest.js";
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
  description:
    "Resolve a destination on CuddlyNest (city / area) to its candidates via the " +
    "public autosuggestion API (name, city/state/country, coordinates, property " +
    "count). Does NOT enumerate a destination's hotels — for a specific hotel's " +
    "rooms and prices use cuddlynest_listing_details.",
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
async function handleSearch(params: any) {
  const { destination } = params;
  const g = normalizeGuests(params);

  if (!destination) return textResult({ error: "Provide `destination`." }, true);

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
        : "Destination(s) resolved. This tool does not list a destination's hotels — " +
          "call cuddlynest_listing_details with a specific hotel URL or product_id.",
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
      const units = result.rooms.map((u) => shapeUnit(u, g.currency));
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
  scrapeTimeoutMs: SCRAPE_TIMEOUT_MS,
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
