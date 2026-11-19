// Attractions booking — AO-83: options -> availability -> checkout.
//
// The same chain the site's activity page uses:
//   1. options: GET /v2/adp/activity/{id} (package ids), /v2/adp/packages/{id}
//      and /v2/adp/skus/{package_id} for the date. Read from the pricing cache.
//   2. availability: POST /v2/adp/check-availability. A LIVE supplier call
//      (Klook / Viator / ...), so L2B: only when the user has picked the tickets
//      and wants to book. Answers the session id checkout needs.
//   3. checkout: POST /v2/booking/checkout on the booking service. Final price
//      with fees, cancellation policy and the traveler fields the supplier asks
//      for. No order is created and nothing is charged.
//
// Creating the booking (POST /v2/booking/create) takes the Stripe payment result,
// which the user can only produce on CuddlyNest's checkout. That hand-off URL is
// CP-11617; until it exists, checkout answers payment "handoff_pending".
//
// Prices: customer prices only. original_price / supplier_total / fx fields are
// the supplier's rate before markup and are never exposed.
//
// Contract: Swagger on staging, checked against real staging calls (Klook test
// activity and a Viator tour, 2026-11-19). Notes: docs/private/attractions-flights-notes.md.

import { BookingError } from "./booking.js";

const SHOPPING_API_URL = (
  process.env.CUDDLYNEST_ATTRACTIONS_API_URL || "https://staging-attractions-shopping-service.cuddlynest.com"
).replace(/\/+$/, "");
const BOOKING_API_URL = (
  process.env.CUDDLYNEST_ATTRACTIONS_BOOKING_API_URL || "https://staging-attractions-booking-service.cuddlynest.com"
).replace(/\/+$/, "");
// Availability waits on the supplier: ~24 s seen on staging.
const TIMEOUT_MS = parseInt(process.env.CUDDLYNEST_ATTRACTIONS_BOOKING_TIMEOUT_MS || "45000", 10);

const MONGO_ID = /^[0-9a-f]{24}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}(:\d{2})?$/;
const MAX_TICKETS = 50;

type Log = (level: "info" | "warn" | "error", message: string, data?: any) => void;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Money {
  amount: number;
  currency: string | null;
}

export interface TicketType {
  skuId: string;
  label: string | null;
  type: string | null; // "adult" | "child" | "infant" | ...
  ages: { min: number | null; max: number | null };
  quantity: { min: number | null; max: number | null };
  /** Price per ticket on the date, when the cache has one. */
  price: Money | null;
  /** Other ticket types this one can only be booked with (e.g. a child needs an adult). */
  requiresAnyOf: string[];
}

export interface AttractionPackage {
  packageId: string;
  title: string | null;
  duration: string | null;
  cancellation: string | null;
  instantConfirmation: boolean | null;
  timeRequired: boolean;
  /** Start times on the date (HH:MM); empty for open-date tickets. */
  times: string[];
  participants: { min: number | null; max: number | null };
  tickets: TicketType[];
}

export interface AttractionOptions {
  activityId: string;
  date: string;
  packages: AttractionPackage[];
}

export interface TicketSelection {
  skuId: string;
  count: number;
}

export interface AvailabilityRequest {
  activityId: string;
  packageId: string;
  date: string;
  time?: string;
  tickets: TicketSelection[];
  log?: Log;
}

export interface TicketLine {
  skuId: string | null;
  label: string | null;
  count: number | null;
  unitPrice: number | null;
  total: number | null;
}

export type AvailabilityResult =
  | {
      available: true;
      sessionId: string;
      date: string;
      time: string | null;
      total: Money | null;
      lines: TicketLine[];
      cancellation: string[];
      priceChanged: boolean;
      timeChanged: { requested: string | null; suggested: string | null } | null;
    }
  | {
      available: false;
      reason: string; // the service's error_code, e.g. TIME_SLOT_REQUIRED, SOLD_OUT_FOR_DATE
      message: string;
      availableTimes: string[];
      suggestedTime: string | null;
      suggestedParticipants: Record<string, number> | null;
      minimumParticipants: number | null;
      requiredSkuIds: string[];
    };

export interface TravelerField {
  key: string;
  label: string | null;
  required: boolean;
  type: string | null;
  options?: unknown[];
}

export interface AttractionCheckout {
  activity: {
    name: string | null;
    location: string | null;
    date: string | null;
    time: string | null;
    timezone: string | null;
    visitors: string | null;
  };
  price: {
    currency: string | null;
    lines: TicketLine[];
    subtotal: number | null;
    serviceFee: number | null;
    serviceFeeWaived: boolean;
    total: number | null;
  };
  cancellation: string | null;
  /** What the supplier needs per traveler; the lead traveler is the contact. */
  travelers: { id: number | null; type: string | null; isLead: boolean; fields: TravelerField[] }[];
  /** Extra answers the supplier asks for (pickup hotel, flight number, ...). */
  extraFields: TravelerField[];
  orderId: string | null;
  payment: { status: "handoff_pending"; note: string };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function call(base: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new BookingError("provider_error", `Attractions booking timed out after ${TIMEOUT_MS} ms.`);
    }
    throw new BookingError("provider_error", `Attractions booking failed: ${e?.message ?? e}`);
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // handled below
  }
  if (res.status === 404) throw new BookingError("invalid_input", "Activity, package or ticket type not found.");
  if (res.status === 422) {
    throw new BookingError("invalid_input", "The attractions service rejected the request.", { detail: json?.detail });
  }
  if (!res.ok) throw new BookingError("provider_error", `Attractions booking answered HTTP ${res.status}.`);
  if (!json || typeof json !== "object") throw new BookingError("provider_error", "Attractions booking did not return JSON.");
  return json;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => !!s) : []);
const hhmm = (t: string) => t.slice(0, 5);

function validateIds(ids: Record<string, string>): void {
  const bad = Object.entries(ids).filter(([, v]) => !MONGO_ID.test(v ?? ""));
  if (bad.length) {
    throw new BookingError("invalid_input", bad.map(([k]) => `${k} must be a 24-character id from the search result`).join("; "));
  }
}

function validateDate(date: string, today = new Date()): void {
  if (!ISO_DATE.test(date ?? "") || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new BookingError("invalid_input", "date must be a valid YYYY-MM-DD date");
  }
  if (date < today.toISOString().slice(0, 10)) throw new BookingError("invalid_input", "date can't be in the past");
}

function mapTicketType(s: any, rules: any): TicketType | null {
  const sku = s?.sku ?? {};
  const skuId = str(s?.sku_id) ?? str(sku.sku_id);
  if (!skuId) return null;
  const type = str(sku.sku_type)?.toLowerCase() ?? null;
  const dep = (rules?.dependencies ?? []).find((d: any) => str(d?.sku_type)?.toLowerCase() === type);
  const price = num(s?.price?.price);
  return {
    skuId,
    label: str(sku.title),
    type,
    ages: { min: num(sku.min_age), max: num(sku.max_age) },
    quantity: { min: num(sku.sku_min_pax), max: num(sku.sku_max_pax) },
    price: price === null ? null : { amount: price, currency: str(s?.price?.currency) },
    requiresAnyOf: strings(dep?.requires_any_of),
  };
}

/** Times (HH:MM) on `date` from the SKUs' cached timeslots, sorted and unique. */
function timesOn(skus: any[], date: string): string[] {
  const times = new Set<string>();
  for (const s of skus) {
    for (const t of s?.price?.timeslots ?? []) {
      const start = str(t?.start_time);
      if (start?.startsWith(date) && start.length > 10) times.add(hhmm(start.slice(11)));
    }
  }
  return [...times].sort();
}

/** One package from the packages and SKUs responses. Exported for tests. */
export function mapPackage(pkg: any, skusBody: any, date: string): AttractionPackage | null {
  const p = pkg?.package ?? {};
  const packageId = str(pkg?.package_id) ?? str(p._id);
  if (!packageId) return null;
  const rules = pkg?.sku_booking_rules ?? p.sku_booking_rules;
  const skus: any[] = Array.isArray(skusBody?.skus) ? skusBody.skus : [];
  return {
    packageId,
    title: str(p.title) ?? str(p.package_name),
    duration: str(p.duration),
    cancellation: str(p.policy) ?? str(p.cancellation_policy_info?.[0]?.cancellation_text),
    instantConfirmation: typeof p.instant_ticket_delivery === "boolean" ? p.instant_ticket_delivery : null,
    timeRequired: p.is_time_required === true,
    times: timesOn(skus, date),
    participants: { min: num(p.package_min_pax), max: num(p.package_max_pax) },
    tickets: skus.map((s) => mapTicketType(s, rules)).filter((t): t is TicketType => !!t),
  };
}

function mapLines(items: any[]): TicketLine[] {
  return items.map((l) => ({
    skuId: str(l?.sku_id) ?? (typeof l?.sku_id === "number" ? String(l.sku_id) : null),
    label: str(l?.label) ?? str(l?.description),
    count: num(l?.count) ?? num(l?.quantity),
    unitPrice: num(l?.unit_price),
    total: num(l?.total_price),
  }));
}

/** check-availability response -> our result. Supplier codes/messages/trace ids are dropped. */
export function mapAvailability(body: any, req: Pick<AvailabilityRequest, "packageId" | "date" | "time">): AvailabilityResult {
  if (body?.success !== true || !str(body?.session_id)) {
    return {
      available: false,
      reason: str(body?.error_code) ?? "UNAVAILABLE",
      // The message can name the supplier and its internal code ("Viator viator_not_available: ...").
      message: (str(body?.message) ?? "Not available for this selection.").replace(/^\w+ \w+_\w+: /, ""),
      availableTimes: strings(body?.available_times).map(hhmm),
      suggestedTime: str(body?.suggested_time),
      suggestedParticipants: body?.suggested_participants && typeof body.suggested_participants === "object"
        ? body.suggested_participants
        : null,
      minimumParticipants: num(body?.minimum_participants_required),
      requiredSkuIds: strings(body?.required_sku_ids),
    };
  }
  const packages = (body.available_options ?? []).flatMap((o: any) => o?.package_list ?? []);
  const pkg = packages.find((p: any) => p?.package_id === req.packageId) ?? packages[0];
  const lines = mapLines(Object.values(pkg?.pricing ?? {}));
  const total = num(body.is_price_changed ? body.new_total_price : null) ?? num(pkg?.total_price);
  return {
    available: true,
    sessionId: body.session_id,
    date: req.date,
    time: req.time ? hhmm(req.time) : null,
    total: total === null ? null : { amount: total, currency: str(body.currency) },
    lines,
    cancellation: strings(body.cancellation_policy),
    priceChanged: body.is_price_changed === true,
    timeChanged: body.is_time_changed ? { requested: str(body.old_time), suggested: str(body.suggested_time) } : null,
  };
}

function mapField(key: string, f: any): TravelerField {
  const options = Array.isArray(f?.options) && f.options.length ? f.options : undefined;
  return {
    key,
    label: str(f?.label),
    required: f?.is_required === true || f?.required === true,
    type: str(f?.type) ?? str(f?.input_type),
    ...(options ? { options } : {}),
  };
}

/** Checkout response -> our shape. Supplier totals, fx and partner fields are dropped. */
export function mapCheckout(body: any): AttractionCheckout {
  const a = body?.activity_info ?? {};
  const p = body?.price_details ?? {};
  const v = body?.visitor_info ?? {};
  const universal: Record<string, any> = v.universal_fields ?? {};
  const types: Record<string, any> = v.visitor_types ?? {};
  const travelers = (v.visitors ?? []).map((t: any) => {
    const keys: string[] = strings(types[t?.type]?.fields);
    return {
      id: num(t?.id),
      type: str(t?.type),
      isLead: t?.is_lead === true,
      fields: (keys.length ? keys : Object.keys(universal)).map((k) => mapField(k, universal[k])),
    };
  });
  const extraFields = [
    ...(body?.provider_info?.fields ?? []).map((f: any) => mapField(str(f?.name) ?? "field", f)),
    ...(body?.booking_extra_info_fields ?? []).map((f: any) => mapField(str(f?.key) ?? str(f?.name) ?? "field", f)),
  ];
  const waived = p.is_service_fees_waived === true;
  return {
    activity: {
      name: str(a.name),
      location: str(a.location),
      date: str(a.date),
      time: str(a.time),
      timezone: str(a.timezone),
      visitors: str(a.visitors),
    },
    price: {
      currency: str(p.currency),
      lines: mapLines(p.price_breakup ?? []),
      subtotal: num(p.subtotal),
      serviceFee: waived ? 0 : num(p.service_fee),
      serviceFeeWaived: waived,
      total: num(p.final_total) ?? num(p.total),
    },
    cancellation: str(body?.cancellation_text?.text) ?? str(p.cancellation_policy),
    travelers,
    extraFields,
    orderId: str(body?.cn_order_id),
    payment: {
      status: "handoff_pending",
      note:
        "Payment and booking confirmation happen on CuddlyNest's checkout; the hand-off link isn't " +
        "available yet (CP-11617). Never ask the user for card details.",
    },
  };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** Packages, ticket types and start times for a date. Pricing-cache reads only. */
export async function getAttractionOptions(activityId: string, date: string, log?: Log): Promise<AttractionOptions> {
  validateIds({ activityId });
  validateDate(date);
  const started = Date.now();
  const detail = await call(SHOPPING_API_URL, `/v2/adp/activity/${activityId}?${new URLSearchParams({ start_time: date })}`);
  const packageIds = strings(detail?.package_ids);
  if (!packageIds.length) return { activityId, date, packages: [] };

  const pkgs = await call(
    SHOPPING_API_URL,
    `/v2/adp/packages/${activityId}?${new URLSearchParams({ package_ids: packageIds.join(","), start_time: date })}`,
  );
  const packages = await Promise.all(
    (pkgs?.packages ?? []).map(async (pkg: any) => {
      const skuIds = strings(pkg?.sku_ids ?? pkg?.package?.sku_ids);
      const skus = skuIds.length
        ? await call(
            SHOPPING_API_URL,
            `/v2/adp/skus/${pkg.package_id}?${new URLSearchParams({ sku_ids: skuIds.join(","), activity_id: activityId, start_time: date })}`,
          )
        : { skus: [] };
      return mapPackage(pkg, skus, date);
    }),
  );
  const result = { activityId, date, packages: packages.filter((p): p is AttractionPackage => !!p) };
  log?.("info", "Attraction options", { activityId, packages: result.packages.length, ms: Date.now() - started });
  return result;
}

/** Live availability check with the supplier (L2B). */
export async function checkAttractionAvailability(req: AvailabilityRequest): Promise<AvailabilityResult> {
  validateIds({ activityId: req.activityId, packageId: req.packageId });
  validateDate(req.date);
  if (req.time != null && !TIME.test(req.time)) throw new BookingError("invalid_input", "time must look like 09:30");
  const tickets = (req.tickets ?? []).filter((t) => t && t.count > 0);
  if (!tickets.length) throw new BookingError("invalid_input", "pick at least one ticket (skuId and count)");
  if (tickets.some((t) => !str(t.skuId) || !Number.isInteger(t.count) || t.count > MAX_TICKETS)) {
    throw new BookingError("invalid_input", `each ticket needs a skuId and a whole count from 1 to ${MAX_TICKETS}`);
  }
  const started = Date.now();
  const body = await call(SHOPPING_API_URL, "/v2/adp/check-availability", {
    activity_id: req.activityId,
    package_id: req.packageId,
    start_time: req.time ? `${req.date} ${req.time.length === 5 ? `${req.time}:00` : req.time}` : req.date,
    sku_list: tickets.map((t) => ({ sku_id: t.skuId, count: t.count })),
    include_activity: false,
    include_packages: false,
    include_skus: false,
  });
  const result = mapAvailability(body, req);
  req.log?.("info", "Attraction availability", {
    activityId: req.activityId,
    available: result.available,
    ...(result.available ? {} : { reason: result.reason }),
    ms: Date.now() - started,
  });
  return result;
}

/** Final price and traveler fields for an available session. Creates nothing. */
export async function attractionCheckout(
  req: { sessionId: string; activityId: string; packageId: string; currency?: string; log?: Log },
): Promise<AttractionCheckout> {
  validateIds({ activityId: req.activityId, packageId: req.packageId });
  if (!str(req.sessionId)) throw new BookingError("invalid_input", "sessionId is required (from the availability check)");
  const body = await call(BOOKING_API_URL, "/v2/booking/checkout", {
    session_id: req.sessionId,
    package_id: req.packageId,
    activity_id: req.activityId,
    ...(req.currency ? { currency: req.currency } : {}),
  });
  if (!body.price_details) {
    throw new BookingError("session_expired", "The availability session expired or is unknown; check availability again.");
  }
  const result = mapCheckout(body);
  req.log?.("info", "Attraction checkout", { activityId: req.activityId, total: result.price.total, currency: result.price.currency });
  return result;
}
