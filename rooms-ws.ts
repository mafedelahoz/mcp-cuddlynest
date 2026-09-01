// WebSocket client for CuddlyNest's room + pricing stream.
//
// Endpoint (captured):
//   wss://ldp.cuddlynest.com/websocket/ldp_room_groups?access_token=<JWT>
//
// The page hands a dedicated Web Worker a postMessage of the form
//   { type: "RequestType.Socket", payload: { data: <SEARCH>, url: <wss url> } }
// and the Worker's only job is to open that socket and forward <SEARCH> as the
// request. We therefore send <SEARCH> (the `payload.data` object) as the single
// outgoing frame. ⚠️ Not byte-confirmed on the wire — the Worker is out of reach
// of page JS — but it is strong evidence.
//
// Server -> client frames look like:
//   { "type": "Connection.Message", "payload": { "status": ..., "data": { ... } } }
//
// Inventory comes from several wholesale suppliers that each answer at their own
// pace, so ONE search yields SEVERAL "partial" frames. The terminal frame has
// BOTH payload.status === "success" AND payload.data.streaming_status === "complete"
// (confirmed by capture); the server then closes the socket. Whole exchange is
// ~3s for ~9 rooms across ~4 partners.

import { EventEmitter } from "node:events";

export const DEFAULT_WS_BASE = "wss://ldp.cuddlynest.com/websocket/ldp_room_groups";

// Optional override of the whole base URL (without the ?access_token=). Handy if
// CuddlyNest moves the endpoint.
export const CUDDLYNEST_WS_BASE =
  process.env.CUDDLYNEST_WS_URL || argValue("--ws-url") || DEFAULT_WS_BASE;

export const CUDDLYNEST_ACCESS_TOKEN =
  process.env.CUDDLYNEST_ACCESS_TOKEN || argValue("--access-token") || "";

function argValue(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export interface RoomsRequest {
  sessionid: string;
  /** The full search object sent as the outgoing frame (see buildSearchFrame). */
  frame: Record<string, unknown>;
  currency: string;
  accessToken: string;
}

export interface RoomsResult {
  status: "complete" | "partial" | "error";
  sessionid: string;
  filters: string[];
  /** Deduped, merged unit_details across every partial message received. */
  unitDetails: any[];
  partnersSeen: string[];
  messageCount: number;
  note?: string;
}

// ---------------------------------------------------------------------------
// Outgoing frame
// ---------------------------------------------------------------------------

export interface SearchFrameParams {
  sessionid: string;
  productId: string;
  checkin: string;
  checkout: string;
  currency: string;
  adults: number;
  children: number;
  infants: number;
  rooms: number;
  childAges: number[];
  location: string; // "City, State, Country"
  locationType: string; // "Hotel"
  userCountry?: string;
}

/**
 * Build the search object, mirroring the captured page->Worker payload's
 * `payload.data`. Child-count derivations:
 *   numberOfChildrenBelow2  = ages < 2
 *   numberOfChildrenBelow17 = ages <= 17   (age 2 counted here, per capture)
 */
export function buildSearchFrame(p: SearchFrameParams): Record<string, unknown> {
  const below2 = p.childAges.filter((a) => a < 2).length;
  const below17 = p.childAges.filter((a) => a <= 17).length;
  return {
    checkin: p.checkin,
    checkout: p.checkout,
    currency: p.currency,
    rooms: p.rooms,
    adults: p.adults,
    children: p.children,
    infants: p.infants,
    childrenAges: p.childAges.join(","),
    product_id: p.productId,
    child_ages: p.childAges,
    numberOfChildrenBelow17: below17,
    numberOfChildrenBelow2: below2,
    listing_id: p.productId,
    sessionid: p.sessionid,
    type: "viewport",
    user_country: p.userCountry ?? "",
    location: p.location,
    location_type: p.locationType,
    price: null,
  };
}

// ---------------------------------------------------------------------------
// Accumulation / merge — network-independent, unit-tested.
// ---------------------------------------------------------------------------

/**
 * Merge unit_details from a newly-arrived partial message into the accumulator.
 * Dedupe key: the room-group offer id(s) when present, else
 * (product_id + partner_id + title + unit_price). Later messages overwrite.
 */
export function mergeUnitDetails(acc: Map<string, any>, incoming: any[]): void {
  for (const unit of incoming ?? []) {
    const groupIds = unit?.room_groups
      ? Object.values(unit.room_groups)
          .map((g: any) => g?.id)
          .filter(Boolean)
      : [];
    const key =
      groupIds.length > 0
        ? `g:${groupIds.sort().join("|")}`
        : [unit?.product_id, unit?.partner_id, unit?.title ?? unit?.old_title, unit?.unit_price].join(
            "::",
          );
    acc.set(key, unit);
  }
}

export function accumulatorToResult(
  sessionid: string,
  acc: Map<string, any>,
  opts: { filters?: string[]; messageCount: number; status: RoomsResult["status"] },
): RoomsResult {
  const unitDetails = [...acc.values()].sort(
    (a, b) => Number(a?.unit_price ?? 0) - Number(b?.unit_price ?? 0),
  );
  const partnersSeen = [
    ...new Set(unitDetails.map((u) => u?.partner_name).filter(Boolean)),
  ] as string[];
  return {
    status: opts.status,
    sessionid,
    filters: opts.filters ?? [],
    unitDetails,
    partnersSeen,
    messageCount: opts.messageCount,
  };
}

/**
 * Given a raw parsed WS message, return its unit_details iff it is a
 * Connection.Message whose sessionid matches ours. `terminal` is true on the
 * final frame (status "success" OR data.streaming_status "complete").
 */
export function extractUnitDetails(
  raw: any,
  expectedSessionId: string,
): {
  matched: boolean;
  status?: string;
  terminal?: boolean;
  unitDetails?: any[];
  filters?: string[];
} {
  if (raw?.type !== "Connection.Message") return { matched: false };
  const data = raw?.payload?.data;
  if (!data) return { matched: false };
  if (expectedSessionId && data.sessionid && data.sessionid !== expectedSessionId) {
    return { matched: false };
  }
  const status = raw.payload.status;
  const terminal = status === "success" || data.streaming_status === "complete";
  return {
    matched: true,
    status,
    terminal,
    unitDetails: Array.isArray(data.unit_details) ? data.unit_details : [],
    filters: Array.isArray(data.filters) ? data.filters : [],
  };
}

// ---------------------------------------------------------------------------
// Live transport
// ---------------------------------------------------------------------------

export interface FetchOpts {
  /** Hard ceiling on the whole exchange. */
  overallTimeoutMs?: number;
  /** Resolve if no new frame arrives for this long after the first one. */
  quietPeriodMs?: number;
  log?: (level: "info" | "warn" | "error", msg: string, data?: any) => void;
}

export function buildWsUrl(base: string, accessToken: string): string {
  const u = new URL(base);
  u.searchParams.set("access_token", accessToken);
  return u.toString();
}

export async function fetchRoomsAndPricing(
  req: RoomsRequest,
  opts: FetchOpts = {},
): Promise<RoomsResult> {
  const log = opts.log ?? (() => {});
  const overallTimeoutMs = opts.overallTimeoutMs ?? 25000;
  const quietPeriodMs = opts.quietPeriodMs ?? 6000;

  if (!req.accessToken) {
    return errResult(req.sessionid, "No access token available for the CuddlyNest WebSocket.");
  }

  let WebSocket: any;
  try {
    ({ default: WebSocket } = await import("ws"));
  } catch {
    return errResult(req.sessionid, "The 'ws' package is not installed. Run `npm install ws`.");
  }

  const wsUrl = buildWsUrl(CUDDLYNEST_WS_BASE, req.accessToken);
  const acc = new Map<string, any>();
  const bus = new EventEmitter();
  let messageCount = 0;
  let filters: string[] = [];
  let terminal = false;

  const ws = new WebSocket(wsUrl, {
    headers: { Origin: "https://www.cuddlynest.com", "User-Agent": "Mozilla/5.0" },
  });

  ws.on("open", () => {
    log("info", "CuddlyNest WS open", { base: CUDDLYNEST_WS_BASE });
    ws.send(JSON.stringify(req.frame));
  });

  ws.on("message", (buf: Buffer) => {
    let raw: any;
    try {
      raw = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const got = extractUnitDetails(raw, req.sessionid);
    if (!got.matched) return;
    messageCount++;
    if (got.filters?.length) filters = got.filters;
    mergeUnitDetails(acc, got.unitDetails ?? []);
    if (got.terminal) terminal = true;
    bus.emit("progress");
  });

  ws.on("error", (err: Error) => bus.emit("fail", err));
  ws.on("close", () => bus.emit("done"));

  const status: RoomsResult["status"] = await new Promise((resolve) => {
    const hardTimer = setTimeout(() => finish("partial"), overallTimeoutMs);
    let quietTimer: NodeJS.Timeout | undefined;

    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish("partial"), quietPeriodMs);
    };
    const finish = (s: RoomsResult["status"]) => {
      clearTimeout(hardTimer);
      if (quietTimer) clearTimeout(quietTimer);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve(terminal ? "complete" : s);
    };

    bus.on("progress", () => (terminal ? finish("complete") : armQuiet()));
    bus.on("done", () => finish(terminal ? "complete" : "partial"));
    bus.on("fail", (e: Error) => {
      log("error", "CuddlyNest WS error", { error: e?.message });
      finish("error");
    });
  });

  const result = accumulatorToResult(req.sessionid, acc, { filters, messageCount, status });
  if (status === "error" && result.unitDetails.length === 0) {
    result.note = "WebSocket errored before any room data arrived. Check the access token / endpoint.";
  }
  return result;
}

function errResult(sessionid: string, note: string): RoomsResult {
  return {
    status: "error",
    sessionid,
    filters: [],
    unitDetails: [],
    partnersSeen: [],
    messageCount: 0,
    note,
  };
}
