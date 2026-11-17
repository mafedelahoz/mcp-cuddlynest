// Flights search — live.
//
// CuddlyNest's flight search engine (V3): POST /api/flight/search starts a
// supplier stream and answers with the session id to read (it can reuse a cached
// session for the same route/date/passengers); GET /api/flight/results waits for
// that stream and returns the itineraries. This is a real-time supplier call, so
// like live stays it is only used with an explicit source: "live", never from
// "auto" / "db", and it never falls back.
//
// Contract: Swagger on staging (the reference per the backend team), checked
// against a real staging search (BOG -> MIA, 2026-11-16). Notes:
// docs/private/attractions-flights-notes.md (kept out of the public repo).
//
// AO-9: there is no flights database (fares come from suppliers), so every live
// search is cached per route / dates / passengers / cabin / currency for a short
// time (default 30 min, under the backend's 35-min results TTL). source "auto" /
// "db" answer from that cache only and never call the API. There is no
// background refresh on purpose: refreshing fares would be a supplier search.
//
// Prices: every amount comes as { amount, currency, api_amount, api_currency }.
// `amount` is the customer price; `api_amount` is the supplier's rate before
// markup and must never be exposed.

import { randomUUID } from "crypto";

import { JsonCache, cacheFilePath } from "./cache.js";

const FLIGHTS_API_URL = (
  process.env.CUDDLYNEST_FLIGHTS_API_URL || "https://staging-flight-search-engine.cuddlynest.com"
).replace(/\/+$/, "");
const FLIGHTS_TIMEOUT_MS = parseInt(process.env.CUDDLYNEST_FLIGHTS_TIMEOUT_MS || "60000", 10);

const MAX_LIMIT = 50;
const IATA = /^[A-Z]{3}$/;
const CABINS = ["economy", "premium_economy", "business", "first"] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlightsErrorCode =
  | "invalid_input"
  | "airport_not_found"
  | "timeout"
  | "http_error"
  | "invalid_response";

export class FlightsError extends Error {
  constructor(
    public readonly code: FlightsErrorCode,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "FlightsError";
  }
}

type Log = (level: "info" | "warn" | "error", message: string, data?: any) => void;
export type CabinClass = (typeof CABINS)[number];

export interface FlightsRequest {
  origin: string;
  destination: string;
  departureDate?: string;
  returnDate?: string;
  adults: number;
  childAges: number[];
  infants: number;
  cabinClass?: string;
  currency: string;
  limit?: number;
  log?: Log;
}

export interface FlightPoint {
  airportCode: string | null;
  airportName: string | null;
  city: string | null;
  country: string | null;
  time: string | null; // local time at the airport, no offset
  terminal: string | null;
}

export interface FlightSegment {
  from: string | null;
  to: string | null;
  departure: string | null;
  arrival: string | null;
  carrier: { code: string | null; name: string | null };
  flightNumber: string | null;
  operatingCarrier: string | null; // only when it differs from the marketing carrier
  duration: string | null; // ISO 8601
}

export interface FlightLeg {
  direction: string | null; // "outbound" | "inbound"
  origin: FlightPoint;
  destination: FlightPoint;
  duration: string | null;
  stops: number;
  segments: FlightSegment[];
}

export interface Money {
  amount: number;
  currency: string | null;
}

export interface Flight {
  id: string;
  type: "flight";
  legs: FlightLeg[];
  airlines: string[];
  stops: number; // max stops over the legs
  baggage: { checked: number | null; carryOn: number | null };
  conditions: { refundable: boolean | null; changeable: boolean | null };
  /** Customer prices only — only ever here, never in the static fields. */
  pricing: {
    total: Money | null;
    base: Money | null;
    taxes: Money | null;
    perPassenger: { type: string | null; count: number | null; total: Money | null }[];
    priceGuaranteeExpiresAt: string | null;
  };
}

export interface FlightsResult {
  route: { origin: string; destination: string; departureDate: string; returnDate: string | null };
  sessionId: string;
  status: string | null;
  totalCount: number | null;
  flights: Flight[];
  /** When the fares were read from the API (now for live, earlier for cache). */
  cachedAt: string;
}

// ---------------------------------------------------------------------------
// Cache (AO-9)
// ---------------------------------------------------------------------------

export const flightsCache = new JsonCache({
  label: "Flights",
  file: cacheFilePath("CUDDLYNEST_FLIGHTS_CACHE_FILE", "flights-cache.json"),
  maxAgeMs: () => {
    const m = Number(process.env.CUDDLYNEST_FLIGHTS_CACHE_MAX_AGE_MINUTES ?? 30);
    return (Number.isFinite(m) && m >= 0 ? m : 30) * 60_000;
  },
  maxEntries: 300,
});

const normPlace = (s: string) => s.trim().split(",")[0].trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

/** Cache key; `from` / `to` are either the typed places or the resolved IATA codes. */
export function flightsCacheKey(req: FlightsRequest, from: string, to: string): string {
  return [
    "flights",
    `${normPlace(from)}>${normPlace(to)}`,
    `${req.departureDate}/${req.returnDate ?? "-"}`,
    `a${req.adults}c${[...req.childAges].sort((x, y) => x - y).join(".")}i${req.infants}`,
    normalizeCabin(req.cabinClass),
    req.currency,
  ].join("|");
}

/** Cache-only read (source "auto" / "db"): never calls the API, not even autosuggest. */
export function getCachedFlights(req: FlightsRequest): FlightsResult | undefined {
  validate(req);
  const hit = flightsCache.get<Omit<FlightsResult, "cachedAt">>(flightsCacheKey(req, req.origin, req.destination));
  if (!hit) return undefined;
  return { ...hit.value, flights: hit.value.flights.slice(0, clampLimit(req.limit)), cachedAt: hit.cachedAt };
}

function clampLimit(limit?: number): number {
  return Math.min(Math.max(1, Math.floor(Number(limit) || 10)), MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(d: string | undefined): d is string {
  if (!d || !ISO_DATE.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

export function normalizeCabin(c?: string): CabinClass {
  const v = String(c ?? "economy").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (CABINS as readonly string[]).includes(v) ? (v as CabinClass) : "economy";
}

/** Passengers block: adults, one entry per child age, infants on lap. */
export function buildPassengers(req: Pick<FlightsRequest, "adults" | "childAges" | "infants">) {
  const pax: { Type: string; Quantity: number; Age?: number }[] = [{ Type: "adult", Quantity: req.adults }];
  for (const age of req.childAges) pax.push({ Type: "child", Quantity: 1, Age: age });
  if (req.infants > 0) pax.push({ Type: "infant", Quantity: req.infants });
  return pax;
}

export function buildSearchRequest(
  req: FlightsRequest,
  origin: string,
  destination: string,
  sessionId: string = randomUUID(),
) {
  const legs = [{ Departure: origin, Arrival: destination, DepartureDate: req.departureDate! }];
  if (req.returnDate) legs.push({ Departure: destination, Arrival: origin, DepartureDate: req.returnDate });
  return {
    SessionID: sessionId,
    FlightSearchRQ: {
      SearchCriteria: { OriginDestinations: legs },
      Passengers: buildPassengers(req),
      Filters: { CabinClass: normalizeCabin(req.cabinClass) },
      Currency: req.currency,
    },
  };
}

function validate(req: FlightsRequest): void {
  const errs: string[] = [];
  if (!req.origin?.trim()) errs.push("`origin` is required for flights.");
  if (!req.destination?.trim()) errs.push("`destination` is required.");
  if (!validDate(req.departureDate)) errs.push("`checkin` (departure date, YYYY-MM-DD) is required.");
  else if (req.departureDate! < new Date().toISOString().slice(0, 10)) errs.push("Departure date is in the past.");
  if (req.returnDate !== undefined && !validDate(req.returnDate)) errs.push("`checkout` (return date) must be YYYY-MM-DD.");
  else if (req.returnDate && req.departureDate && req.returnDate < req.departureDate) {
    errs.push("Return date is before the departure date.");
  }
  if (!(req.adults >= 1)) errs.push("At least one adult is required.");
  if (req.infants > req.adults) errs.push("Each infant needs an adult.");
  if (req.adults + req.childAges.length + req.infants > 9) errs.push("At most 9 passengers.");
  if (!/^[A-Z]{3}$/.test(req.currency)) errs.push("`currency` must be an ISO code like USD.");
  if (errs.length) throw new FlightsError("invalid_input", errs.join(" "));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  let res: Response;
  try {
    res = await fetch(`${FLIGHTS_API_URL}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(FLIGHTS_TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new FlightsError("timeout", `Flight search timed out after ${FLIGHTS_TIMEOUT_MS} ms.`);
    }
    throw new FlightsError("http_error", `Flight search failed: ${e?.message ?? e}`);
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // handled by the callers
  }
  return { status: res.status, body };
}

/** "Bogotá" -> "BOG". An IATA code passes through untouched. */
export async function resolveAirport(input: string): Promise<{ code: string; label: string }> {
  const q = input.trim();
  if (IATA.test(q)) return { code: q, label: q };
  const city = q.split(",")[0].trim();
  const { status, body } = await call(`/api/flight/autosuggest?${new URLSearchParams({ query: city, limit: "5" })}`);
  if (status !== 200 || !Array.isArray(body?.data)) {
    throw new FlightsError("http_error", `Airport lookup answered HTTP ${status}.`, status);
  }
  const hit = body.data.find((c: any) => !c.is_nearby_match) ?? body.data[0];
  // A city with one airport -> that airport; several -> the city code (e.g. LON).
  const code = hit?.airports?.length === 1 ? hit.airports[0].airport_code : hit?.city_code;
  if (!code) throw new FlightsError("airport_not_found", `No airport found for "${input}".`);
  return { code, label: `${hit.city_name}, ${hit.country_name} (${code})` };
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

function point(p: any): FlightPoint {
  const l = p?.Location ?? {};
  return {
    airportCode: str(l.AirportCode),
    airportName: str(l.AirportName),
    city: str(l.CityName),
    country: str(l.CountryName),
    time: str(p?.DateTime),
    terminal: str(p?.Terminal),
  };
}

function segment(s: any): FlightSegment {
  const mk = s?.MarketingCarrier ?? {};
  const op = s?.OperatingCarrier ?? {};
  const opCode = str(op.Code);
  return {
    from: str(s?.Departure?.Location?.AirportCode),
    to: str(s?.Arrival?.Location?.AirportCode),
    departure: str(s?.Departure?.DateTime),
    arrival: str(s?.Arrival?.DateTime),
    carrier: { code: str(mk.Code), name: str(mk.Name) },
    flightNumber: str(mk.Code) && str(mk.FlightNumber) ? `${mk.Code}${mk.FlightNumber}` : str(mk.FlightNumber),
    operatingCarrier: opCode && opCode !== str(mk.Code) ? str(op.Name) ?? opCode : null,
    duration: str(s?.Duration),
  };
}

function baggage(legs: any[]): Flight["baggage"] {
  // First passenger, first segment: what's included per person.
  const bags: any[] = legs?.[0]?.Segments?.[0]?.PassengerAmenities?.[0]?.Baggages ?? [];
  const included = (type: string) => {
    const b = bags.filter((x) => x?.Type === type && x?.IsChargeable !== true);
    return b.length ? b.reduce((n, x) => n + (num(x.Quantity) ?? 0), 0) : bags.length ? 0 : null;
  };
  return { checked: included("checked"), carryOn: included("carry_on") };
}

function mapItinerary(it: any): Flight | null {
  const id = str(it?.ItineraryID);
  const rawLegs: any[] = Array.isArray(it?.Legs) ? it.Legs : [];
  if (!id || !rawLegs.length) return null;
  const legs: FlightLeg[] = rawLegs.map((l) => {
    const segments = (Array.isArray(l?.Segments) ? l.Segments : []).map(segment);
    return {
      direction: str(l?.LegType),
      origin: point(l?.Origin),
      destination: point(l?.Destination),
      duration: str(l?.Duration),
      stops: Math.max(segments.length - 1, 0),
      segments,
    };
  });
  const conds = rawLegs.map((l) => l?.SliceConditions ?? {});
  const all = (k: string) =>
    conds.every((c) => typeof c[k] === "boolean") ? conds.every((c) => c[k] === true) : null;
  const total = it?.ItineraryFares?.TotalPrice ?? {};
  return {
    id,
    type: "flight",
    legs,
    airlines: [...new Set(legs.flatMap((l) => l.segments.map((s) => s.carrier.name ?? s.carrier.code)).filter((x): x is string => !!x))],
    stops: Math.max(0, ...legs.map((l) => l.stops)),
    baggage: baggage(rawLegs),
    conditions: { refundable: all("Refundable"), changeable: all("Changeable") },
    pricing: {
      total: money(total.TotalAmount),
      base: money(total.BaseAmount),
      taxes: money(total.TotalTax),
      perPassenger: (it?.ItineraryFares?.PassengerFares ?? []).map((p: any) => ({
        type: str(p?.Type),
        count: num(p?.Count),
        total: money(p?.Fare?.TotalAmount),
      })),
      priceGuaranteeExpiresAt: str(it?.PaymentTTL?.PriceGuaranteeExpiresAt),
    },
  };
}

/** /api/flight/results body -> Flight[]. Never throws on odd shapes. */
export function mapFlightResults(body: unknown): { flights: Flight[]; totalCount: number | null; dropped: number } {
  const rs = (body as any)?.FlightSearchRS;
  const list: unknown[] = Array.isArray(rs?.Itineraries) ? rs.Itineraries : [];
  const flights = list.map(mapItinerary).filter((f): f is Flight => !!f);
  return { flights, totalCount: num(rs?.TotalItineraries), dropped: list.length - flights.length };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export async function searchFlights(req: FlightsRequest): Promise<FlightsResult> {
  validate(req);
  const started = Date.now();
  const [from, to] = await Promise.all([resolveAirport(req.origin), resolveAirport(req.destination)]);
  if (from.code === to.code) throw new FlightsError("invalid_input", "Origin and destination are the same.");

  const search = await call("/api/flight/search", {
    method: "POST",
    body: JSON.stringify(buildSearchRequest(req, from.code, to.code)),
  });
  if (search.status !== 200) {
    throw new FlightsError("http_error", `Flight search answered HTTP ${search.status}.`, search.status);
  }
  // The answer is the session to read, which may be a cached one, not ours.
  const sessionId = typeof search.body === "string" ? search.body : str(search.body?.SessionID);
  if (!sessionId) throw new FlightsError("invalid_response", "Flight search returned no session id.");

  // The page maximum, so the cached list can serve any `limit`.
  const q = new URLSearchParams({ sessionID: sessionId, sortBy: "best", page: "1", size: String(MAX_LIMIT) });
  let results = await call(`/api/flight/results?${q}`);
  // The backend sometimes gives up waiting on its stream (408) while a second read
  // of the same session succeeds. Re-reading doesn't start a new supplier search.
  if (results.status === 408) {
    req.log?.("info", "Flight results 408, reading the session once more", { route: `${from.code}-${to.code}` });
    results = await call(`/api/flight/results?${q}`);
  }
  if (results.status === 408) throw new FlightsError("timeout", "Flight results timed out on the backend.", 408);
  if (results.status !== 200) {
    throw new FlightsError("http_error", `Flight results answered HTTP ${results.status}.`, results.status);
  }
  if (!results.body?.FlightSearchRS) throw new FlightsError("invalid_response", "Flight results have no FlightSearchRS.");

  const { flights, totalCount, dropped } = mapFlightResults(results.body);
  req.log?.("info", "Flight search", {
    route: `${from.code}-${to.code}`,
    count: flights.length,
    dropped,
    status: results.body.Status,
    ms: Date.now() - started,
  });
  const full = {
    route: { origin: from.label, destination: to.label, departureDate: req.departureDate!, returnDate: req.returnDate ?? null },
    sessionId,
    status: str(results.body.Status),
    totalCount,
    flights,
  };
  let cachedAt = new Date().toISOString();
  if (flights.length) {
    // Under the typed places and the IATA codes, so "Bogotá" and "BOG" both hit.
    const keys = new Set([flightsCacheKey(req, req.origin, req.destination), flightsCacheKey(req, from.code, to.code)]);
    for (const k of keys) cachedAt = flightsCache.set(k, full, undefined, { flush: false });
    flightsCache.flush();
  }
  return { ...full, flights: flights.slice(0, clampLimit(req.limit)), cachedAt };
}
