// Flights booking — AO-84: price -> checkout -> (hand-off, pending).
//
// CuddlyNest's flight booking engine:
//   1. price: POST /api/flight/booking/price re-prices one itinerary of a search
//      session with the supplier (LIVE call, L2B): only when the user picked a
//      flight and wants to book. If the offer can't be priced the engine may price
//      an equivalent one (same flights and rules, other supplier): `substituted`.
//   2. checkout: POST /api/flight/booking/checkout re-validates the price and
//      creates a PENDING booking (CNBookingID) with the passengers' details. No
//      payment and no ticket.
//   3. book: POST /api/flight/booking/book takes raw card data, which the MCP must
//      never handle. Payment needs CuddlyNest's checkout (hand-off URL, CP-11618) or
//      a tokenized book endpoint (CP-11615); until then checkout answers payment
//      "handoff_pending".
//
// Prices: every amount is { amount, currency, api_amount, api_currency };
// api_amount is the supplier's rate before markup and is never exposed.
//
// Contract: Swagger on staging, price checked against a real staging session
// (BOG -> MIA, 2026-11-19). Checkout is mapped from the Swagger only: calling it
// creates a pending booking with passenger data, so it isn't exercised against
// staging without an explicit go-ahead.

import { BookingError, comparePrices, type PriceChange } from "./booking.js";

const BOOKING_API_URL = (
  process.env.CUDDLYNEST_FLIGHTS_BOOKING_API_URL || "https://staging-flight-booking-engine.cuddlynest.com"
).replace(/\/+$/, "");
const TIMEOUT_MS = parseInt(process.env.CUDDLYNEST_FLIGHTS_BOOKING_TIMEOUT_MS || "60000", 10);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO2 = /^[A-Z]{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// The engine's rule: start with a letter; letters, spaces, hyphens, apostrophes.
const NAME = /^\p{L}[\p{L} '\-]*$/u;
const PASSENGER_TYPES = ["adult", "child", "infant"] as const;
const TITLES = ["mr", "mrs", "ms", "miss", "dr", "master"] as const;

type Log = (level: "info" | "warn" | "error", message: string, data?: any) => void;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Money {
  amount: number;
  currency: string | null;
}

export interface FlightPrice {
  status: string | null;
  /** The itinerary actually priced; differs from the requested one when substituted. */
  flightId: string | null;
  substituted: boolean;
  substitutionReason: string | null;
  price: { base: Money | null; taxes: Money | null; serviceFee: Money | null; total: Money | null };
  /** Total before this re-price, and how it moved. */
  previousTotal: Money | null;
  priceChange: PriceChange | null;
  conditions: { refundable: boolean | null; changeable: boolean | null; refundFee: Money | null };
  baggage: { passengerType: string | null; checked: number; carryOn: number }[];
  seatSelection: string | null; // "not_available" | "free" | "paid"
  seatSelectionRequired: boolean;
  /** Seconds until the search session (and this price) expires. */
  expiresInSeconds: number | null;
}

export interface PassengerDocument {
  type: string; // e.g. "passport"
  number: string;
  issuingCountry: string; // ISO alpha-2
  expiryDate: string; // YYYY-MM-DD
}

export interface FlightPassenger {
  type: (typeof PASSENGER_TYPES)[number];
  title: (typeof TITLES)[number];
  firstName: string;
  lastName: string;
  gender: "m" | "f" | "o";
  dateOfBirth: string;
  nationality: string; // ISO alpha-2
  document?: PassengerDocument;
}

export interface FlightContact {
  email: string;
  phoneCountryCode: string; // e.g. "+57"
  phoneNumber: string;
  address: { street: string; city: string; state: string; postalCode: string; country: string };
}

export interface FlightCheckout extends FlightPrice {
  bookingId: string;
  payment: { status: "handoff_pending"; note: string };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function post(path: string, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BOOKING_API_URL}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new BookingError("provider_error", `Flight booking timed out after ${TIMEOUT_MS} ms.`);
    }
    throw new BookingError("provider_error", `Flight booking failed: ${e?.message ?? e}`);
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // handled below
  }
  if (res.status === 422) {
    throw new BookingError("invalid_input", "The flight booking engine rejected the request.", { detail: json?.detail });
  }
  // An error status can still carry a priced response with its Error filled in.
  if (!res.ok && !(json?.FlightPriceRS || json?.FlightCheckoutRS)) {
    throw new BookingError("provider_error", `Flight booking answered HTTP ${res.status}.`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** Customer amount only; api_amount (supplier rate) is dropped on purpose. */
function money(p: any): Money | null {
  const amount = num(p?.amount);
  return amount === null ? null : { amount, currency: str(p?.currency) };
}

function errorText(e: any): string | null {
  if (!e) return null;
  if (typeof e === "string") return e;
  return str(e.Message) ?? str(e.message) ?? str(e.Code) ?? str(e.code) ?? JSON.stringify(e).slice(0, 200);
}

/** Throw when the engine answered an error instead of a price. */
function assertPriced(rs: any): void {
  const err = errorText(rs?.Error);
  const status = str(rs?.Status);
  if (!err && status && /^confirmed$/i.test(status)) return;
  if (!err && !status && rs?.Itinerary) return;
  const text = err ?? `Flight could not be priced (status ${status ?? "unknown"}).`;
  if (/session.?expired|expired/i.test(text)) {
    throw new BookingError("session_expired", "The flight search expired; search again with source \"live\".");
  }
  throw new BookingError("room_unavailable", `This flight can't be booked right now: ${text}`, { status });
}

function mapBaggage(list: any[]): FlightPrice["baggage"] {
  return list.map((p) => {
    const bags: any[] = p?.Baggages ?? [];
    const count = (types: string[]) =>
      bags.filter((b) => types.includes(String(b?.Type))).reduce((n, b) => n + (num(b?.Quantity) ?? 0), 0);
    const type = str(p?.Type);
    return {
      passengerType: type === "ADT" ? "adult" : type === "CHD" ? "child" : type === "INF" ? "infant" : type,
      checked: count(["checked"]),
      carryOn: count(["carry_on"]),
    };
  });
}

/** FlightPriceRS / FlightCheckoutRS -> our shape. Exported for tests. */
export function mapFlightPrice(rs: any): FlightPrice {
  assertPriced(rs);
  const it = rs?.Itinerary ?? {};
  const now = it?.Price?.Updated ?? it?.Price?.Original ?? {};
  const before = it?.Price?.Original ?? null;
  const total = money(now.TotalAmount);
  const base = money(now.BaseAmount);
  const taxes = money(now.TotalTax);
  const feeAdj = (rs?.Adjustments ?? []).find((a: any) => a?.Type === "service_fee" && a?.ApplyServiceFee !== false);
  const fee = num(feeAdj?.Amount);
  const previousTotal = before ? money(before.TotalAmount) : null;
  const fr = it?.FareRule ?? {};
  return {
    status: str(rs?.Status),
    flightId: str(it?.ItineraryID),
    substituted: rs?.Substituted === true,
    substitutionReason: str(rs?.SubstitutionReason),
    price: {
      base,
      taxes,
      serviceFee: fee === null ? null : { amount: fee, currency: total?.currency ?? null },
      total,
    },
    previousTotal,
    priceChange:
      previousTotal && total
        ? comparePrices(
            { amount: previousTotal.amount, currency: previousTotal.currency ?? "" },
            { amount: total.amount, currency: total.currency ?? "" },
          )
        : null,
    conditions: { refundable: bool(fr.Refundable), changeable: bool(fr.Changeable), refundFee: money(fr.Refund) },
    baggage: mapBaggage(it?.Baggages ?? []),
    seatSelection: str(rs?.SeatSelection),
    seatSelectionRequired: rs?.SeatSelectionRequired === true,
    expiresInSeconds: num(rs?.ResultsTTL),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validDate(d: string | undefined): boolean {
  if (!d || !ISO_DATE.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

function validateRef(sessionId: string, flightId: string): void {
  const errors: string[] = [];
  if (!str(sessionId)) errors.push("sessionId is required (from the live flights search)");
  if (!str(flightId)) errors.push("flightId is required (the flight's id in the search result)");
  if (errors.length) throw new BookingError("invalid_input", errors.join("; "), { errors });
}

/** Problems with passengers and contact; empty when valid. `today` is injectable for tests. */
export function validatePassengers(passengers: FlightPassenger[], contact: FlightContact, today = new Date()): string[] {
  const errors: string[] = [];
  const todayIso = today.toISOString().slice(0, 10);
  if (!Array.isArray(passengers) || !passengers.length) errors.push("at least one passenger is required");
  for (const [i, p] of (passengers ?? []).entries()) {
    const at = `passengers[${i}]`;
    if (!PASSENGER_TYPES.includes(p?.type)) errors.push(`${at}.type must be adult, child or infant`);
    if (!TITLES.includes(p?.title)) errors.push(`${at}.title must be one of ${TITLES.join(", ")}`);
    if (!NAME.test(p?.firstName ?? "")) errors.push(`${at}.firstName must start with a letter (letters, spaces, - and ')`);
    if (!NAME.test(p?.lastName ?? "")) errors.push(`${at}.lastName must start with a letter (letters, spaces, - and ')`);
    if (!["m", "f", "o"].includes(p?.gender)) errors.push(`${at}.gender must be m, f or o`);
    if (!validDate(p?.dateOfBirth) || p.dateOfBirth >= todayIso) errors.push(`${at}.dateOfBirth must be a past YYYY-MM-DD date`);
    if (!ISO2.test(p?.nationality ?? "")) errors.push(`${at}.nationality must be an ISO alpha-2 code, e.g. CO`);
    if (p?.document) {
      const d = p.document;
      if (!str(d.type) || !str(d.number)) errors.push(`${at}.document needs type and number`);
      if (!ISO2.test(d.issuingCountry ?? "")) errors.push(`${at}.document.issuingCountry must be ISO alpha-2`);
      if (!validDate(d.expiryDate) || d.expiryDate <= todayIso) errors.push(`${at}.document.expiryDate must be a future YYYY-MM-DD date`);
    }
  }
  if (!(passengers ?? []).some((p) => p?.type === "adult")) errors.push("at least one adult passenger is required");
  if (!EMAIL.test(contact?.email ?? "")) errors.push("contact.email must be a valid address");
  if (!/^\+\d{1,4}$/.test(contact?.phoneCountryCode ?? "")) errors.push("contact.phoneCountryCode must look like +57");
  if (!/^\d{5,15}$/.test((contact?.phoneNumber ?? "").replace(/[\s-]/g, ""))) errors.push("contact.phoneNumber must be 5-15 digits");
  const a = contact?.address;
  for (const k of ["street", "city", "state", "postalCode", "country"] as const) {
    if (!str(a?.[k])) errors.push(`contact.address.${k} is required`);
  }
  if (a?.postalCode && !/^[A-Za-z0-9 -]{3,10}$/.test(a.postalCode)) errors.push("contact.address.postalCode must be 3-10 letters, digits, spaces or -");
  if (a?.country && !ISO2.test(a.country)) errors.push("contact.address.country must be ISO alpha-2");
  return errors;
}

/** Contact block in the engine's shape. Exported for tests. */
export function buildContactInfo(c: FlightContact) {
  return {
    Contact: { Email: c.email, Phone: c.phoneNumber.replace(/[\s-]/g, ""), CountryCode: c.phoneCountryCode },
    Address: {
      Street: c.address.street,
      City: c.address.city,
      State: c.address.state,
      PostalCode: c.address.postalCode,
      Country: c.address.country,
    },
  };
}

/** Passenger list in the engine's shape; the lead (first adult) carries the contact. Exported for tests. */
export function buildPassengerList(passengers: FlightPassenger[], contact: FlightContact) {
  const lead = passengers.findIndex((p) => p.type === "adult");
  return passengers.map((p, i) => ({
    Type: p.type,
    Title: p.title,
    FirstName: p.firstName.trim(),
    LastName: p.lastName.trim(),
    Gender: p.gender,
    DateOfBirth: p.dateOfBirth,
    Nationality: p.nationality,
    Document: p.document
      ? { Type: p.document.type, Number: p.document.number, IssuingCountry: p.document.issuingCountry, ExpiryDate: p.document.expiryDate }
      : null,
    ContactInfo: i === lead ? buildContactInfo(contact) : null,
  }));
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** Re-price one itinerary with the supplier (live, L2B). Books nothing. */
export async function priceFlight(req: { sessionId: string; flightId: string; currency?: string; log?: Log }): Promise<FlightPrice> {
  validateRef(req.sessionId, req.flightId);
  const started = Date.now();
  const body = await post("/api/flight/booking/price", {
    FlightPriceRQ: {
      SessionID: req.sessionId,
      ItineraryID: req.flightId,
      ...(req.currency ? { Currency: req.currency } : {}),
      IncludeDetail: false,
    },
  });
  const result = mapFlightPrice(body?.FlightPriceRS);
  req.log?.("info", "Flight priced", {
    substituted: result.substituted,
    priceChange: result.priceChange?.direction,
    ms: Date.now() - started,
  });
  return result;
}

/** Final price check + pending booking (CNBookingID). Charges nothing, issues no ticket. */
export async function checkoutFlight(req: {
  sessionId: string;
  flightId: string;
  currency?: string;
  passengers: FlightPassenger[];
  contact: FlightContact;
  log?: Log;
}): Promise<FlightCheckout> {
  validateRef(req.sessionId, req.flightId);
  const errors = validatePassengers(req.passengers, req.contact);
  if (errors.length) throw new BookingError("invalid_input", errors.join("; "), { errors });
  const body = await post("/api/flight/booking/checkout", {
    FlightCheckoutRQ: {
      SessionID: req.sessionId,
      ItineraryID: req.flightId,
      ...(req.currency ? { Currency: req.currency } : {}),
      PassengerList: buildPassengerList(req.passengers, req.contact),
      ContactInfo: buildContactInfo(req.contact),
      AllowSubstitution: false,
    },
  });
  const rs = body?.FlightCheckoutRS;
  const priced = mapFlightPrice(rs);
  const bookingId = str(rs?.CNBookingID);
  if (!bookingId) throw new BookingError("provider_error", "Flight checkout returned no booking id.");
  // Passenger details never go to the logs: counts only.
  req.log?.("info", "Flight checkout created", { passengers: req.passengers.length, total: priced.price.total });
  return {
    ...priced,
    bookingId,
    payment: {
      status: "handoff_pending",
      note:
        "Payment and ticketing happen on CuddlyNest's checkout; the hand-off link isn't available yet " +
        "(CP-11618 / CP-11615). Never ask the user for card details.",
    },
  };
}
