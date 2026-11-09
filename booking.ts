// Booking flow for the CN MCP (AO-16): quote -> pre-book (price confirm) ->
// checkout hand-off -> status.
//
// The steps mirror how CuddlyNest bookings work today: a priced room is
// identified by search_id / room_contract_set_id / redis_key, the price is
// re-confirmed with the supplier before payment, and payment happens on
// CuddlyNest's checkout. The MCP never handles card data.
//
// What's ours and done here: input validation, price-change detection, quote
// expiry, flow ordering, and PII-safe logging. What's NOT known yet: the backend
// endpoints and their request/response shapes. Those go behind BookingProvider;
// until the contract arrives the active provider is `pendingBookingProvider`,
// which answers "contract_pending". To switch, implement the backend provider and
// change `bookingProvider` at the bottom of this file.
//
// L2B: pre-book is a live supplier call. These tools only exist when
// CUDDLYNEST_ENABLE_BOOKING_TOOLS=true, and nothing else in the server calls them.

import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Types (our own names, not the backend's)
// ---------------------------------------------------------------------------

export interface Money {
  amount: number;
  currency: string;
}

/** Identifies one priced room offer, as returned by the room-level live prices API. */
export interface RoomRef {
  productId: string;
  searchId: string;
  roomContractSetId: string;
  redisKey?: string;
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

export interface RoomGuest {
  title?: string;
  firstName: string;
  lastName: string;
}

/** Lead guest; optional at hand-off (the user can fill it in on our checkout). */
export interface GuestDetails {
  title?: string;
  firstName: string;
  lastName: string;
  email: string;
  phoneCountryCode: string; // e.g. "+57"
  phoneNumber: string;
  country: string; // ISO 3166-1 alpha-2
  dateOfBirth?: string; // YYYY-MM-DD
  remarks?: string;
  roomGuests?: RoomGuest[];
}

export interface CancellationPolicy {
  refundable: boolean;
  /** Free cancellation until this ISO time, when known. */
  freeCancellationUntil?: string;
  text?: string[];
}

export interface Quote {
  quoteId: string;
  room: RoomRef;
  stay: StayRequest;
  total: Money;
  cancellation?: CancellationPolicy;
  expiresAt: string; // ISO
}

export interface PreBook {
  prebookId: string;
  quoteId: string;
  total: Money;
  previousTotal: Money;
  priceChange: PriceChange;
  cancellation?: CancellationPolicy;
  expiresAt: string;
}

export interface CheckoutHandoff {
  checkoutUrl: string;
  bookingReference?: string;
  expiresAt?: string;
}

export type BookingStatusValue = "pending" | "booked" | "cancelled" | "failed" | "unknown";

export interface BookingStatus {
  bookingReference: string;
  status: BookingStatusValue;
  checkin?: string;
  checkout?: string;
}

// ---------------------------------------------------------------------------
// Provider (the backend side; contract pending)
// ---------------------------------------------------------------------------

export type BookingErrorCode =
  | "contract_pending"
  | "invalid_input"
  | "quote_not_found"
  | "quote_expired"
  | "prebook_not_found"
  | "prebook_expired"
  | "price_change_not_accepted"
  | "room_unavailable"
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

/** What the backend has to provide. Field shapes are ours; the real provider maps to them. */
export interface BookingProvider {
  readonly name: string;
  /** Price a specific room for the stay. No supplier booking is made. */
  quote(room: RoomRef, stay: StayRequest): Promise<Omit<Quote, "quoteId" | "expiresAt"> & { expiresAt?: string }>;
  /** Re-confirm price and availability with the supplier (live call). */
  prebook(quote: Quote): Promise<{ total: Money; cancellation?: CancellationPolicy; expiresAt?: string; providerRef?: string }>;
  /** Create the checkout session/enquiry and return where the user pays. */
  createCheckout(prebook: PreBook, quote: Quote, guest?: GuestDetails): Promise<CheckoutHandoff>;
  getStatus(bookingReference: string): Promise<BookingStatus>;
}

const pending = (step: string) =>
  new BookingError(
    "contract_pending",
    `Booking step "${step}" isn't available yet: the backend booking API contract hasn't been provided.`,
  );

export const pendingBookingProvider: BookingProvider = {
  name: "pending",
  async quote() {
    throw pending("quote");
  },
  async prebook() {
    throw pending("prebook");
  },
  async createCheckout() {
    throw pending("checkout");
  },
  async getStatus() {
    throw pending("status");
  },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

export function validateRoomRef(r: Partial<RoomRef>): string[] {
  const errors: string[] = [];
  for (const k of ["productId", "searchId", "roomContractSetId"] as const) {
    if (!r[k] || typeof r[k] !== "string") errors.push(`${k} is required (from the room-level live prices result)`);
  }
  return errors;
}

/** Problems with lead-guest details; empty when valid. */
export function validateGuest(g: GuestDetails, today = new Date()): string[] {
  const errors: string[] = [];
  if (!g.firstName?.trim()) errors.push("firstName is required");
  if (!g.lastName?.trim()) errors.push("lastName is required");
  if (!EMAIL_RE.test(g.email ?? "")) errors.push("email must be a valid address");
  if (!/^\+\d{1,4}$/.test(g.phoneCountryCode ?? "")) errors.push("phoneCountryCode must look like +57");
  if (!/^\d{5,15}$/.test((g.phoneNumber ?? "").replace(/[\s-]/g, ""))) errors.push("phoneNumber must be 5-15 digits");
  if (!/^[A-Z]{2}$/.test(g.country ?? "")) errors.push("country must be an ISO alpha-2 code, e.g. CO");
  if (g.dateOfBirth != null) {
    const dob = parseDate(g.dateOfBirth);
    if (dob == null) errors.push("dateOfBirth must be a valid YYYY-MM-DD date");
    else {
      const adultCutoff = Date.UTC(today.getUTCFullYear() - 18, today.getUTCMonth(), today.getUTCDate());
      if (dob > adultCutoff) errors.push("the lead guest must be 18 or older");
    }
  }
  for (const [i, r] of (g.roomGuests ?? []).entries()) {
    if (!r.firstName?.trim() || !r.lastName?.trim()) errors.push(`roomGuests[${i}] needs firstName and lastName`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// PII-safe logging
// ---------------------------------------------------------------------------

const mask = (s?: string) => (s ? `${s.slice(0, 1)}***` : undefined);

/** Guest details reduced to what's safe to log: initials, email domain, country. */
export function redactGuest(g?: GuestDetails) {
  if (!g) return undefined;
  return {
    name: `${mask(g.firstName)} ${mask(g.lastName)}`,
    email: g.email?.includes("@") ? `***@${g.email.split("@")[1]}` : "***",
    phone: "***",
    country: g.country,
    roomGuests: g.roomGuests?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Price changes
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
// Flow (ordering + state), independent of the backend contract
// ---------------------------------------------------------------------------

type Log = (level: "info" | "warn" | "error", message: string, data?: any) => void;

const DEFAULT_QUOTE_TTL_MS = 15 * 60_000;
const DEFAULT_PREBOOK_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 1000;

export class BookingFlow {
  private quotes = new Map<string, Quote>();
  private prebooks = new Map<string, PreBook>();

  constructor(
    private readonly provider: BookingProvider,
    private readonly opts: { log?: Log; now?: () => number } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private remember<T>(map: Map<string, T>, key: string, value: T) {
    map.set(key, value);
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
  }

  private expired(iso: string) {
    return Date.parse(iso) <= this.now();
  }

  async quote(room: RoomRef, stay: StayRequest): Promise<Quote> {
    const errors = [...validateRoomRef(room), ...validateStay(stay, new Date(this.now()))];
    if (errors.length) throw new BookingError("invalid_input", errors.join("; "), { errors });
    const q = await this.provider.quote(room, stay);
    const quote: Quote = {
      ...q,
      quoteId: randomUUID(),
      expiresAt: q.expiresAt ?? new Date(this.now() + DEFAULT_QUOTE_TTL_MS).toISOString(),
    };
    this.remember(this.quotes, quote.quoteId, quote);
    this.opts.log?.("info", "Booking quote created", { productId: room.productId, total: quote.total });
    return quote;
  }

  async prebook(quoteId: string): Promise<PreBook> {
    const quote = this.quotes.get(quoteId);
    if (!quote) throw new BookingError("quote_not_found", "Unknown quoteId; create a new quote first.");
    if (this.expired(quote.expiresAt)) throw new BookingError("quote_expired", "The quote expired; create a new one.");
    const p = await this.provider.prebook(quote);
    const prebook: PreBook = {
      prebookId: randomUUID(),
      quoteId,
      total: p.total,
      previousTotal: quote.total,
      priceChange: comparePrices(quote.total, p.total),
      cancellation: p.cancellation ?? quote.cancellation,
      expiresAt: p.expiresAt ?? new Date(this.now() + DEFAULT_PREBOOK_TTL_MS).toISOString(),
    };
    this.remember(this.prebooks, prebook.prebookId, prebook);
    this.opts.log?.("info", "Booking pre-book confirmed", {
      productId: quote.room.productId,
      priceChange: prebook.priceChange.direction,
    });
    return prebook;
  }

  async checkout(prebookId: string, opts: { acceptPriceChange?: boolean; guest?: GuestDetails } = {}) {
    const prebook = this.prebooks.get(prebookId);
    if (!prebook) throw new BookingError("prebook_not_found", "Unknown prebookId; pre-book the quote first.");
    if (this.expired(prebook.expiresAt)) {
      throw new BookingError("prebook_expired", "The pre-book expired; pre-book the quote again.");
    }
    if (prebook.priceChange.requiresAcceptance && !opts.acceptPriceChange) {
      throw new BookingError(
        "price_change_not_accepted",
        "The price went up since the quote. Confirm with the user, then retry with acceptPriceChange: true.",
        { previousTotal: prebook.previousTotal, total: prebook.total, priceChange: prebook.priceChange },
      );
    }
    if (opts.guest) {
      const errors = validateGuest(opts.guest, new Date(this.now()));
      if (errors.length) throw new BookingError("invalid_input", errors.join("; "), { errors });
    }
    const quote = this.quotes.get(prebook.quoteId)!;
    const handoff = await this.provider.createCheckout(prebook, quote, opts.guest);
    this.opts.log?.("info", "Booking checkout hand-off created", {
      productId: quote.room.productId,
      guest: redactGuest(opts.guest),
    });
    return { handoff, total: prebook.total, cancellation: prebook.cancellation };
  }

  async status(bookingReference: string): Promise<BookingStatus> {
    if (!bookingReference?.trim()) throw new BookingError("invalid_input", "bookingReference is required");
    return this.provider.getStatus(bookingReference.trim());
  }
}

// ---------------------------------------------------------------------------
// Active provider — the one place to switch to the backend implementation.
// ---------------------------------------------------------------------------

export const bookingProvider: BookingProvider = pendingBookingProvider;

export function isBookingEnabled(): boolean {
  return process.env.CUDDLYNEST_ENABLE_BOOKING_TOOLS === "true";
}
