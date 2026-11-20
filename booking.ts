// Stays booking for the CN MCP (AO-82): a room rate -> Request to Book -> the
// CuddlyNest checkout URL, where the user sees the re-confirmed price and
// cancellation policy (side widget), enters card details and pays (Stripe).
//
// Request to Book (checkout-request-to-book service, JWT as Bearer) creates the
// enquiry and starts the supplier pre-book, so it is a live supplier call (L2B):
// only for an explicit booking flow, behind CUDDLYNEST_ENABLE_BOOKING_TOOLS. The
// MCP never handles card data. There is no booking-status API yet.

import { AuthError, getAccessToken, invalidateAccessToken } from "./auth.js";

// Read per call so tests (and a running server's env) can point it elsewhere.
const apiUrl = () =>
  (process.env.CUDDLYNEST_REQUEST_TO_BOOK_API_URL || "https://staging-checkout-request-to-book.cuddlynest.com").replace(
    /\/+$/,
    "",
  );
const timeoutMs = () => parseInt(process.env.CUDDLYNEST_REQUEST_TO_BOOK_TIMEOUT_MS || "30000", 10);

type Log = (level: "info" | "warn" | "error", message: string, data?: any) => void;

// ---------------------------------------------------------------------------
// Types (our own names, not the backend's)
// ---------------------------------------------------------------------------

export interface Money {
  amount: number;
  currency: string;
}

/** One bookable room rate, as listed under `bookingOptions` by cuddlynest_listing_details. */
export interface StayOffer {
  /** Rate product_id, e.g. "3234329_4264955" (not the plain hotel id). */
  productId: string;
  roomId: string;
  recordId?: string;
  redisKey?: string;
  roomRedisKey?: string;
}

export interface StayRequest {
  checkin: string; // YYYY-MM-DD
  checkout: string;
  adults: number;
  children: number;
  childAges: number[];
  infants: number;
  rooms: number;
  currency: string;
}

export interface StayCheckout {
  checkoutUrl: string;
  bookingReference: string | null;
  enquiryId: string | null;
}

export type BookingErrorCode =
  | "contract_pending"
  | "invalid_input"
  | "price_change_not_accepted"
  | "room_unavailable"
  | "session_expired"
  | "provider_error";

export class BookingError extends Error {
  constructor(
    public readonly code: BookingErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BookingError";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s: string): number | null {
  if (!DATE_RE.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? null : t;
}

/** Problems with a stay request; empty when valid. `today` is injectable for tests. */
export function validateStay(s: StayRequest, today = new Date()): string[] {
  const errors: string[] = [];
  const ci = parseDate(s.checkin);
  const co = parseDate(s.checkout);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (ci == null) errors.push("checkin must be a valid YYYY-MM-DD date");
  if (co == null) errors.push("checkout must be a valid YYYY-MM-DD date");
  if (ci != null && ci < todayUtc) errors.push("checkin can't be in the past");
  if (ci != null && co != null && co <= ci) errors.push("checkout must be after checkin");
  if (!Number.isInteger(s.adults) || s.adults < 1) errors.push("at least 1 adult is required");
  if (!Number.isInteger(s.rooms) || s.rooms < 1) errors.push("at least 1 room is required");
  if (Number.isInteger(s.rooms) && Number.isInteger(s.adults) && s.rooms > s.adults) {
    errors.push("each room needs at least one adult");
  }
  if (!Number.isInteger(s.children) || s.children < 0) errors.push("children must be 0 or more");
  if (s.childAges.length !== s.children) errors.push("childAges must list one age per child");
  if (s.childAges.some((a) => !Number.isInteger(a) || a < 0 || a > 17)) errors.push("child ages must be 0-17");
  if (!Number.isInteger(s.infants) || s.infants < 0) errors.push("infants must be 0 or more");
  if (!/^[A-Z]{3}$/.test(s.currency)) errors.push("currency must be an ISO 4217 code, e.g. USD");
  return errors;
}

export function validateOffer(o: Partial<StayOffer>): string[] {
  const errors: string[] = [];
  if (!o.productId || typeof o.productId !== "string") errors.push("offer.productId is required");
  if (!o.roomId || typeof o.roomId !== "string") errors.push("offer.roomId is required");
  if (!o.redisKey && !o.roomRedisKey) errors.push("offer.redisKey or offer.roomRedisKey is required");
  return errors;
}

// ---------------------------------------------------------------------------
// Price changes (used by the flights re-price)
// ---------------------------------------------------------------------------

export interface PriceChange {
  changed: boolean;
  direction: "up" | "down" | "none";
  difference: number; // new - old, in the quote currency
  percent: number;
  /** True when the user must explicitly accept before checkout. */
  requiresAcceptance: boolean;
}

// Differences at or under this are treated as rounding, not a price change.
const PRICE_TOLERANCE = { absolute: 0.01, percent: 0.5 };

export function comparePrices(before: Money, after: Money): PriceChange {
  if (before.currency !== after.currency) {
    // Can't compare safely across currencies: always ask the user.
    return { changed: true, direction: "up", difference: NaN, percent: NaN, requiresAcceptance: true };
  }
  const difference = Math.round((after.amount - before.amount) * 100) / 100;
  const percent = before.amount ? Math.round((difference / before.amount) * 10_000) / 100 : 0;
  const changed = Math.abs(difference) > PRICE_TOLERANCE.absolute && Math.abs(percent) > PRICE_TOLERANCE.percent;
  const direction = !changed ? "none" : difference > 0 ? "up" : "down";
  return { changed, direction, difference, percent, requiresAcceptance: direction === "up" };
}

// ---------------------------------------------------------------------------
// Request to Book
// ---------------------------------------------------------------------------

/** Query string the site sends for one room (product page "Reserve" button). */
export function buildRequestToBookQuery(offer: StayOffer, stay: StayRequest): URLSearchParams {
  const q = new URLSearchParams({
    product_id: offer.productId,
    checkin: stay.checkin,
    checkout: stay.checkout,
    guests: String(stay.adults + stay.children),
    adults: String(stay.adults),
    children: String(stay.children),
    infants: String(stay.infants),
    rooms: String(stay.rooms),
    currency: stay.currency,
    room_id: offer.roomId,
  });
  for (const age of stay.childAges) q.append("child_ages[]", String(age));
  if (offer.recordId) q.set("record_id", offer.recordId);
  if (offer.redisKey) q.set("redis_key", offer.redisKey);
  if (offer.roomRedisKey) q.set("room_redis_key", offer.roomRedisKey);
  return q;
}

/** Only ever hand the user a CuddlyNest https link. */
function isCuddlyNestUrl(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname === "cuddlynest.com" || url.hostname.endsWith(".cuddlynest.com"));
  } catch {
    return false;
  }
}

const str = (v: unknown) => (v == null || v === "" ? null : String(v));

/**
 * Maps a Request to Book response. The site redirects to `data.url` when
 * statusCode is 200; anything else means the rate can't be booked any more
 * (the site marks the room as "broke" and shows `message`).
 */
export function mapRequestToBook(body: any): StayCheckout {
  const data = body?.data ?? {};
  if (body?.statusCode !== 200 || !data.url) {
    throw new BookingError(
      "room_unavailable",
      `This room can't be booked right now${body?.message ? `: ${body.message}` : ""}. Pick another rate or room.`,
    );
  }
  if (!isCuddlyNestUrl(data.url)) {
    throw new BookingError("provider_error", "Request to Book answered a checkout link outside cuddlynest.com");
  }
  return {
    checkoutUrl: data.url,
    bookingReference: str(data.booking_no),
    enquiryId: str(data.enquiry_id ?? data.enId),
  };
}

/** Bearer JWT; a 401/403 drops the cached token and retries once. */
async function getWithJwt(url: string): Promise<{ status: number; body: any }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let token: string;
    try {
      token = await getAccessToken();
    } catch (e) {
      if (e instanceof AuthError) throw new BookingError("provider_error", `Booking auth failed: ${e.message}`);
      throw e;
    }
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json", "X-Authorization": `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs()),
      });
    } catch (e) {
      const code = (e as any)?.name === "TimeoutError" ? "timeout" : "network";
      throw new BookingError("provider_error", `Request to Book unreachable (${code})`);
    }
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      invalidateAccessToken();
      continue;
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, body };
  }
  throw new BookingError("provider_error", "Request to Book refused the token twice");
}

/**
 * Creates the enquiry for one room rate and returns the checkout URL. Live
 * supplier call (pre-book), so only on an explicit booking request.
 */
export async function requestToBook(
  offer: StayOffer,
  stay: StayRequest,
  opts: { log?: Log; today?: Date } = {},
): Promise<StayCheckout> {
  const errors = [...validateOffer(offer), ...validateStay(stay, opts.today)];
  if (errors.length) throw new BookingError("invalid_input", errors.join("; "), { errors });

  const url = `${apiUrl()}/api/v1/product/request_to_book?${buildRequestToBookQuery(offer, stay)}`;
  const started = Date.now();
  const { status, body } = await getWithJwt(url);
  if (status === 422) {
    const detail = Array.isArray(body?.detail) ? body.detail.map((d: any) => `${(d?.loc ?? []).join(".")}: ${d?.msg}`) : [];
    throw new BookingError("invalid_input", `Request to Book rejected the request${detail.length ? `: ${detail.join("; ")}` : ""}`);
  }
  if (status === 401 || status === 403) throw new BookingError("provider_error", `Request to Book refused the token (HTTP ${status})`);
  if (status < 200 || status >= 300 || !body) throw new BookingError("provider_error", `Request to Book answered HTTP ${status}`);

  const checkout = mapRequestToBook(body);
  opts.log?.("info", "Stay request to book created", {
    productId: offer.productId,
    bookingReference: checkout.bookingReference,
    ms: Date.now() - started,
  });
  return checkout;
}

/** No booking-status API exists yet (asked in CP-11612). */
export async function getStayBookingStatus(bookingReference: string): Promise<never> {
  if (!bookingReference?.trim()) throw new BookingError("invalid_input", "bookingReference is required");
  throw new BookingError(
    "contract_pending",
    "Booking status isn't available from the assistant yet. The user gets the confirmation by email and in their CuddlyNest account.",
  );
}

export function isBookingEnabled(): boolean {
  return process.env.CUDDLYNEST_ENABLE_BOOKING_TOOLS === "true";
}
