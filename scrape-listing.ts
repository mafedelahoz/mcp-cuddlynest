// Reads room availability, price and cancellation policy for a CuddlyNest
// listing by opening the real, public listing page in a headless browser and
// reading what is already rendered on screen — the same content any visitor
// sees. It does NOT call CuddlyNest's WebSocket, does not touch their internal
// auth/token endpoints, and carries no access token. The page's own JavaScript
// opens its own session exactly as it does for a human visitor; we only read
// the resulting DOM.
//
// Ported from the standalone `cuddlynest-mcp` prototype into this repo's
// conventions (flat file, NodeNext, .js import specifiers).

import fetch from "node-fetch";
import type { Browser, Page } from "playwright";

export const BASE_URL = "https://www.cuddlynest.com";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScrapeSearchParams {
  productId: string;
  /**
   * Listing path segment after `/hotel/`, e.g. "co/hotel-sansiraka-4395541".
   * Resolve it from a bare product_id with resolveListingPath().
   */
  listingPath: string;
  checkin: string; // YYYY-MM-DD
  checkout: string; // YYYY-MM-DD
  adults: number;
  children?: number;
  childrenAges?: number[];
  infants?: number;
  rooms?: number;
  currency?: string; // e.g. "COP", "USD"
}

export interface PriceBreakdown {
  total: { amount: number; name: string };
  prices: Array<{ amount: number; name: string | number; sub_text?: number }>;
  pay_now: { name: string; amount: number };
  old_unit_price?: number;
  old_base_price?: number;
  price_diff?: number;
}

export interface CancellationPolicy {
  type: string;
  text: string[];
  partner_cp?: Array<{ amount: number; currency: string; start: string; end: string }>;
  partner_cp_new?: Array<{
    amount: number;
    currency: string;
    start_date_time: string;
    end_date_time: string;
    refund_percentage: number;
  }>;
}

export interface RoomOffer {
  product_id: string;
  partner_id: number | string;
  partner_name: string;
  title: string;
  remaining_rooms: number;
  guests: number;
  unit_price: number;
  price_breakdown: PriceBreakdown;
  cancellation_policy: CancellationPolicy;
  room_filters: string[];
}

export interface ListingSearchResult {
  url: string;
  fromPriceText: string | null;
  rooms: RoomOffer[];
  scrapedAt: string;
}

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

/**
 * Build the CuddlyNest listing URL for a search. Pure — no I/O.
 * `listingPath` must be supplied (see resolveListingPath()).
 */
export function buildListingUrl(params: ScrapeSearchParams): string {
  const {
    listingPath,
    checkin,
    checkout,
    adults,
    children = 0,
    childrenAges = [],
    infants = 0,
    rooms = 1,
    currency = "USD",
  } = params;

  const url = new URL(`${BASE_URL}/hotel/${listingPath}`);
  url.searchParams.set("checkin", checkin);
  url.searchParams.set("checkout", checkout);
  url.searchParams.set("adults", String(adults));
  url.searchParams.set("children", String(children));
  url.searchParams.set("infants", String(infants));
  url.searchParams.set("rooms", String(rooms));
  url.searchParams.set("currency", currency);
  if (childrenAges.length > 0) {
    url.searchParams.set("childrenAges", childrenAges.join(","));
  }
  return url.toString();
}

/**
 * Resolve a bare product_id to its canonical listing path segment
 * (e.g. "4395541" -> "co/hotel-sansiraka-4395541").
 *
 * `https://www.cuddlynest.com/hotel/-<id>` server-redirects to the canonical
 * slug URL; we follow it and take the path after `/hotel/`. Public, no auth.
 */
export async function resolveListingPath(productId: string, timeoutMs = 15000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/hotel/-${encodeURIComponent(productId)}`, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    const landed = new URL(res.url);
    const m = landed.pathname.match(/^\/hotel\/(.+?)\/?$/);
    if (!m || /^-?\d+$/.test(m[1])) {
      throw new Error(
        `Could not resolve a canonical listing path for product_id ${productId} ` +
          `(landed at ${res.url}).`,
      );
    }
    return m[1];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// In-page DOM extraction
// ---------------------------------------------------------------------------

/**
 * Runs inside the page (page.evaluate). Walks every price-shaped text node
 * ("COL$742,637"), then walks up its React fiber tree to the nearest ancestor
 * component whose props carry both `unit_price` and `roomGroups` — those props
 * are the room offer CuddlyNest already rendered for a real visitor.
 *
 * Does NOT touch the WebSocket, the worker, or any auth token.
 */
function extractRoomsFromDom(): { fromPriceText: string | null; rooms: RoomOffer[] } {
  function findFiberKey(el: Element): string | undefined {
    return Object.keys(el).find((k) => k.startsWith("__reactFiber"));
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const priceLineRe = /^[A-Z]{2,4}\$[\d,]+(\.\d+)?$/; // e.g. COL$742,637 / USD$232

  const seen = new Set<string>();
  const rooms: RoomOffer[] = [];
  let node: Node | null;

  while ((node = walker.nextNode())) {
    const text = (node.textContent || "").trim();
    if (!priceLineRe.test(text)) continue;

    const el = node.parentElement;
    if (!el) continue;
    const key = findFiberKey(el);
    if (!key) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fiber: any = (el as any)[key];
    let hops = 0;
    while (fiber && hops < 40) {
      const p = fiber.memoizedProps;
      if (p && typeof p === "object" && "unit_price" in p && "roomGroups" in p) {
        const dedupeKey = `${p.product_id}|${p.title}|${p.partner_name}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          rooms.push({
            product_id: p.product_id,
            partner_id: p.partner_id,
            partner_name: p.partner_name,
            title: p.title,
            remaining_rooms: p.remaining_rooms,
            guests: p.guests,
            unit_price: p.unit_price,
            price_breakdown: p.price_breakdown,
            cancellation_policy: p.cancellation_policy,
            room_filters: p.room_filters,
          });
        }
        break;
      }
      fiber = fiber.return;
      hops += 1;
    }
  }

  const fromEl = Array.from(document.querySelectorAll("*")).find(
    (e) => e.textContent && /^From$/.test(e.textContent.trim()),
  );
  let fromPriceText: string | null = null;
  if (fromEl) {
    const container = fromEl.closest("div");
    const match = container?.textContent?.match(/[A-Z]{2,4}\$[\d,]+(\.\d+)?/);
    fromPriceText = match ? match[0] : null;
  }

  return { fromPriceText, rooms };
}

// ---------------------------------------------------------------------------
// scrapeListing
// ---------------------------------------------------------------------------

export interface ScrapeOptions {
  /** Reuse an already-open Playwright page instead of launching a browser. */
  page?: Page;
  /** Max time to wait for at least one room price to render, ms. */
  timeoutMs?: number;
  /**
   * After the first price renders, keep polling until the extracted room count
   * stops growing (suppliers stream in at different speeds). Give up after this
   * long. Default 15000ms.
   */
  settleTimeoutMs?: number;
  /**
   * Never return before this long after the first price, even if the room count
   * already looks stable — slow suppliers can arrive several seconds after the
   * first. Default 6000ms.
   */
  minSettleMs?: number;
  /** Executable path override for sandboxed environments. */
  executablePath?: string;
  headless?: boolean;
  log?: (level: "info" | "warn" | "error", msg: string, data?: any) => void;
}

/**
 * Opens the real CuddlyNest listing page (or reuses `options.page`), waits for
 * the room/price section to render, and extracts the same data a human visitor
 * sees. Does not call any CuddlyNest API/WebSocket directly.
 */
export async function scrapeListing(
  params: ScrapeSearchParams,
  options: ScrapeOptions = {},
): Promise<ListingSearchResult> {
  const url = buildListingUrl(params);
  const { timeoutMs = 30000, settleTimeoutMs = 15000, minSettleMs = 6000 } = options;
  const log = options.log ?? (() => {});

  let browser: Browser | undefined;
  let page = options.page;
  let ownPage = false;

  if (!page) {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      throw new Error(
        "Playwright is not installed. Run `npm install` (the postinstall fetches " +
          "Chromium) or `npx playwright install chromium`.",
      );
    }
    try {
      browser = await chromium.launch({
        headless: options.headless ?? true,
        executablePath: options.executablePath,
      });
    } catch (e) {
      throw new Error(
        `Could not launch Chromium (${e instanceof Error ? e.message : String(e)}). ` +
          "Run `npx playwright install chromium`.",
      );
    }
    page = await browser.newPage();
    ownPage = true;
  }

  try {
    log("info", "Opening CuddlyNest listing page", { url });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    // Prices render async (client-side). Wait for a price-shaped text node
    // rather than a fixed sleep.
    await page.waitForFunction(
      () => {
        const re = /^[A-Z]{2,4}\$[\d,]+(\.\d+)?$/;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = walker.nextNode())) {
          if (re.test((n.textContent || "").trim())) return true;
        }
        return false;
      },
      { timeout: timeoutMs },
    );

    // Suppliers stream in at different speeds. Poll the extracted room count and
    // stop once it has been stable for two consecutive polls (or we hit the
    // settle budget). Beats a fixed sleep, which either cuts slow partners off
    // or wastes time when everything is already in.
    const pollMs = 1000;
    const started = Date.now();
    const settleDeadline = started + settleTimeoutMs;
    let stableFor = 0;
    let lastCount = -1;
    while (Date.now() < settleDeadline) {
      await page.waitForTimeout(pollMs);
      const count = await page.evaluate(() => {
        // inline mini-extractor: just count price-shaped nodes with a fiber match
        const re = /^[A-Z]{2,4}\$[\d,]+(\.\d+)?$/;
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const keys = new Set<string>();
        let n: Node | null;
        while ((n = w.nextNode())) {
          if (!re.test((n.textContent || "").trim())) continue;
          const el = n.parentElement;
          if (!el) continue;
          const fk = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
          if (!fk) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let f: any = (el as any)[fk];
          let hops = 0;
          while (f && hops < 40) {
            const p = f.memoizedProps;
            if (p && typeof p === "object" && "unit_price" in p && "roomGroups" in p) {
              keys.add(`${p.product_id}|${p.title}|${p.partner_name}`);
              break;
            }
            f = f.return;
            hops++;
          }
        }
        return keys.size;
      });
      if (count === lastCount) stableFor++;
      else stableFor = 0;
      lastCount = count;
      // Stable for 3 polls AND past the minimum floor -> everything's in.
      if (stableFor >= 3 && Date.now() - started >= minSettleMs) break;
    }

    const { fromPriceText, rooms } = await page.evaluate(extractRoomsFromDom);
    log("info", "Extracted rooms from listing DOM", { count: rooms.length, fromPriceText });

    return { url, fromPriceText, rooms, scrapedAt: new Date().toISOString() };
  } finally {
    if (ownPage) {
      await page.close();
      await browser?.close();
    }
  }
}

// Exported for unit testing without a real browser.
export const __internal = { extractRoomsFromDom };
