// Stays booking for the CN MCP (AO-82): a room rate -> Request to Book -> the
// CuddlyNest checkout page, where the user enters card details and pays (Stripe).
//
// Request to Book (JWT as Bearer) creates the enquiry (guest, user_id 0) and
// starts the supplier pre-book, so it is a live supplier call (L2B): only for an
// explicit booking flow, behind CUDDLYNEST_ENABLE_BOOKING_TOOLS. Right after it we
// read the checkout's side widget (final price, cancellation) and the booking
// status (booking number), the same reads the checkout page makes. The MCP never
// handles card data. Checked end to end on staging 2026-11-20.

import { AuthError, getAccessToken, invalidateAccessToken } from "./auth.js";

// Read per call so tests (and a running server's env) can point them elsewhere.
// Prod hosts drop the "staging-" prefix (checkout-request-to-book.cuddlynest.com...).
const envUrl = (name: string, fallback: string) => (process.env[name] || fallback).replace(/\/+$/, "");
const apiUrl = () =>
  envUrl("CUDDLYNEST_REQUEST_TO_BOOK_API_URL", "https://staging-checkout-request-to-book.cuddlynest.com");
const sideWidgetUrl = () =>
  envUrl("CUDDLYNEST_CHECKOUT_SIDE_WIDGET_API_URL", "https://staging-checkout-side-widget-detail.cuddlynest.com");
const statusUrl = () =>
  envUrl("CUDDLYNEST_CHECKOUT_CONFIRM_BOOKING_API_URL", "https://staging-checkout-confirm-booking.cuddlynest.com");
/** Request to Book answers a relative checkout path; staging enquiries only open on the staging site. */
const siteUrl = () =>
  envUrl(
    "CUDDLYNEST_CHECKOUT_SITE_URL",
    new URL(apiUrl()).hostname.startsWith("staging-") ? "https://staging.cuddlynest.com" : "https://www.cuddlynest.com",
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
  enquiryId: string;
  /** Booking number shown to the user (e.g. CN...), from the booking status. */
  bookingReference: string | null;
  /** Final price as the checkout shows it; null when the side widget couldn't be read. */
  price: StayPrice | null;
  cancellation: StayCancellation | null;
}

export interface StayPrice {
  total: Money | null;
  lines: Array<{ name: string; amount: string }>;
}

export interface StayCancellation {
  type: string | null;
  policies: string[];
  firstRefundDate: string | null;
}

export type BookingStatusValue = "pending" | "booked" | "cancelled" | "declined" | "unknown";

export interface StayBookingStatus {
  bookingReference: string | null;
  status: BookingStatusValue;
  /** Backend status as given, e.g. "Pending", "Cancelled", "Dismissed". */
  backendStatus: string | null;
  checkin: string | null;
  checkout: string | null;
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
 * Maps a Request to Book response. Success is `data.url` (a relative
 * "booking-payment/<enquiry id>?h=<hash>" path) plus `data.enId`. Without a url
 * the rate can't be booked: the site marks the room as unavailable and shows
 * `message` ("Sold out" comes back as statusCode 200 with no url).
 */
export function mapRequestToBook(body: any, site = siteUrl()): { checkoutUrl: string; enquiryId: string } {
  const data = body?.data ?? {};
  if (body?.statusCode !== 200 || !data.url || data.enId == null) {
    const message = data.message ?? body?.message;
    throw new BookingError(
      "room_unavailable",
      `This room can't be booked right now${message ? `: ${message}` : ""}. Pick another rate or room.`,
      data.price_changed ? { priceChanged: true, oldPrice: data.old_price ?? null, newPrice: data.new_price ?? null } : undefined,
    );
  }
  let checkoutUrl: string;
  try {
    checkoutUrl = new URL(String(data.url), `${site}/`).toString();
  } catch {
    throw new BookingError("provider_error", "Request to Book answered an unreadable checkout link");
  }
  if (!isCuddlyNestUrl(checkoutUrl)) {
    throw new BookingError("provider_error", "Request to Book answered a checkout link outside cuddlynest.com");
  }
  return { checkoutUrl, enquiryId: String(data.enId) };
}

/**
 * Price and cancellation from the checkout side widget. Only the bill lines and
 * policy text the page shows; never `debug`, `prebook_res`, `provider_info` or
 * payment fields (supplier rates, partner booking ids).
 */
export function mapSideWidget(body: any, currency: string): { price: StayPrice; cancellation: StayCancellation } | null {
  const d = body?.data;
  if (body?.statusCode !== 200 || !d) return null;
  const bill = d.bill_info ?? {};
  const amount = Number(bill.amount_pc);
  const cp = d.cancellation_policy ?? {};
  return {
    price: {
      total: Number.isFinite(amount) && amount > 0 ? { amount, currency } : null,
      lines: (Array.isArray(bill.details) ? bill.details : [])
        .filter((l: any) => l?.name && l?.amount != null)
        .map((l: any) => ({ name: String(l.name), amount: String(l.amount) })),
    },
    cancellation: {
      type: str(cp.type),
      policies: (Array.isArray(cp.policies) ? cp.policies : []).map((p: any) => p?.text).filter(Boolean),
      firstRefundDate: str(cp.first_refund_date),
    },
  };
}

const STATUS_MAP: Record<string, BookingStatusValue> = {
  pending: "pending",
  booked: "booked",
  confirmed: "booked",
  completed: "booked",
  cancelled: "cancelled",
  canceled: "cancelled",
  dismissed: "declined",
  declined: "declined",
};

export function mapBookingStatus(body: any): StayBookingStatus {
  const d = body?.data ?? {};
  const backendStatus = str(body?.status);
  return {
    bookingReference: str(d.booking_no),
    status: STATUS_MAP[(backendStatus ?? "").toLowerCase()] ?? "unknown",
    backendStatus,
    checkin: str(d.checkin)?.slice(0, 10) ?? null,
    checkout: str(d.checkout)?.slice(0, 10) ?? null,
  };
}

/** GET with the service JWT as Bearer; a 401/403 drops the cached token and retries once. */
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
      throw new BookingError("provider_error", `Booking service unreachable (${code})`);
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
  throw new BookingError("provider_error", "Booking service refused the token twice");
}

/** A read the checkout page makes anyway; its failure never fails the booking step. */
async function optionalRead(url: string): Promise<any> {
  try {
    const { status, body } = await getWithJwt(url);
    return status === 200 ? body : null;
  } catch {
    return null;
  }
}

/**
 * Creates the enquiry for one room rate and returns the checkout link, with the
 * final price and cancellation policy. Live supplier call (pre-book), so only on
 * an explicit booking request.
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

  const { checkoutUrl, enquiryId } = mapRequestToBook(body);
  const id = encodeURIComponent(enquiryId);
  const [widget, statusBody] = await Promise.all([
    optionalRead(`${sideWidgetUrl()}/api/v1/checkoutpage/side_widget_detail?booking_id=${id}&currency=${stay.currency}`),
    optionalRead(`${statusUrl()}/api/v1/checkoutpage/booking_status?booking_id=${id}`),
  ]);
  const details = mapSideWidget(widget, stay.currency);
  const checkout: StayCheckout = {
    checkoutUrl,
    enquiryId,
    bookingReference: statusBody ? mapBookingStatus(statusBody).bookingReference : null,
    price: details?.price ?? null,
    cancellation: details?.cancellation ?? null,
  };
  opts.log?.("info", "Stay request to book created", {
    productId: offer.productId,
    enquiryId,
    bookingReference: checkout.bookingReference,
    priced: checkout.price?.total != null,
    ms: Date.now() - started,
  });
  return checkout;
}

/**
 * Status of a booking this flow created. The status endpoint answers any
 * enquiry id, so both the id and its booking number must match: the MCP won't
 * look up bookings by guessing sequential ids.
 */
export async function getStayBookingStatus(enquiryId: string, bookingReference: string): Promise<StayBookingStatus> {
  if (!/^\d+$/.test(enquiryId ?? "")) throw new BookingError("invalid_input", "enquiryId must be the numeric id from the checkout step");
  if (!bookingReference?.trim()) throw new BookingError("invalid_input", "bookingReference is required");
  const { status, body } = await getWithJwt(`${statusUrl()}/api/v1/checkoutpage/booking_status?booking_id=${enquiryId}`);
  const notFound = () => new BookingError("invalid_input", "No booking matches that enquiryId and bookingReference.");
  if (status === 404) throw notFound();
  if (status !== 200 || !body) throw new BookingError("provider_error", `Booking status answered HTTP ${status}`);
  const mapped = mapBookingStatus(body);
  if (mapped.bookingReference?.toUpperCase() !== bookingReference.trim().toUpperCase()) throw notFound();
  return mapped;
}

export function isBookingEnabled(): boolean {
  return process.env.CUDDLYNEST_ENABLE_BOOKING_TOOLS === "true";
}
