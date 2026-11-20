// Room offers for one hotel from the LDP room-groups socket, the one the listing
// page itself opens (wss://ldp.cuddlynest.com/websocket/ldp_room_groups). Same
// data the page renders (scrape-listing.ts reads it back out of the DOM), in 1-6 s
// instead of a ~30 s headless-browser scrape, and without depending on the
// frontend's React props.
//
// Opt-in: used only when CUDDLYNEST_LDP_ROOMS_URL and the JWT credentials are
// set; otherwise listing details keep scraping the public page. Same supplier
// footprint as opening the listing page (it is the page's own request), so it
// runs only where the page scrape ran: listing details with dates.
//
// Frames: a "Socket Connection Established" ack, then "partial" frames as
// suppliers answer, then one with status "success" / streaming_status "complete".
// Each carries the full unit_details so far. Checked on staging 2026-11-20.

import { AuthError, getAccessToken, invalidateAccessToken, isAuthConfigured } from "./auth.js";
import type { BookingOption, RoomOffer } from "./scrape-listing.js";

const roomsUrl = () => process.env.CUDDLYNEST_LDP_ROOMS_URL?.trim() || "";
const ORIGIN = process.env.CUDDLYNEST_BE_ORIGIN || "https://www.cuddlynest.com";
const timeoutMs = () => parseInt(process.env.CUDDLYNEST_LDP_ROOMS_TIMEOUT_MS || "25000", 10);

export function isLdpRoomsEnabled(): boolean {
  return !!roomsUrl() && isAuthConfigured();
}

export class LdpRoomsError extends Error {
  constructor(
    public readonly code: "unauthorized" | "timeout" | "unavailable" | "no_units",
    message: string,
  ) {
    super(message);
    this.name = "LdpRoomsError";
  }
}

export interface LdpRoomsRequest {
  productId: string;
  checkin: string;
  checkout: string;
  adults: number;
  children: number;
  childAges: number[];
  infants: number;
  rooms: number;
  currency: string;
  /** "City, State, Country"; the page sends it (part of the session key). */
  location?: string;
}

export interface LdpRoomsResult {
  rooms: RoomOffer[];
  /** False when the socket timed out before the last supplier answered. */
  complete: boolean;
}

/** The message the listing page sends, field for field. */
export function buildRoomsMessage(r: LdpRoomsRequest) {
  return {
    checkin: r.checkin,
    checkout: r.checkout,
    currency: r.currency,
    rooms: r.rooms,
    adults: r.adults,
    children: r.children,
    infants: r.infants,
    childrenAges: r.childAges.join(","),
    product_id: r.productId,
    child_ages: r.childAges,
    numberOfChildrenBelow17: r.childAges.filter((a) => a >= 2).length,
    numberOfChildrenBelow2: r.childAges.filter((a) => a < 2).length,
    listing_id: r.productId,
    type: "viewport",
    location: r.location ?? "",
    location_type: "Hotel",
    price: null,
  };
}

/** Room groups (keyed by cancellation policy) -> one option per rate (meal plan). */
export function bookingOptionsFrom(groups: any): BookingOption[] {
  const list = Array.isArray(groups) ? groups : groups && typeof groups === "object" ? Object.values(groups) : [];
  const out: BookingOption[] = [];
  for (const g of list as any[]) {
    const rates = Array.isArray(g?.extras) && g.extras.length ? g.extras : [g];
    for (const r of rates) {
      if (!r?.id || !r?.product_id) continue;
      out.push({
        product_id: String(r.product_id),
        room_id: String(r.id),
        record_id: r.record_id ?? g.record_id,
        redis_key: r.redis_key ?? g.redis_key,
        room_redis_key: r.room_redis_key ?? g.room_redis_key,
        extra_type: r.extra_type,
        extra_title: r.extra_title,
        group_title: g.group_title,
        cancellation_policy_type: g.cancellation_policy_type,
        unit_price: r.unit_price,
      });
    }
  }
  return out;
}

/** unit_details -> the RoomOffer shape the page scrape produces. */
export function mapUnits(units: any[]): RoomOffer[] {
  return (Array.isArray(units) ? units : []).map((u) => ({
    product_id: u?.product_id,
    partner_id: u?.partner_id,
    partner_name: u?.partner_name,
    title: u?.title,
    remaining_rooms: u?.remaining_rooms,
    guests: u?.guests,
    unit_price: u?.unit_price,
    price_breakdown: u?.price_breakdown,
    cancellation_policy: u?.cancellation_policy,
    room_filters: u?.room_filters,
    booking_options: bookingOptionsFrom(u?.room_groups),
  }));
}

class HandshakeFailed extends Error {}

function readRooms(message: unknown, token: string): Promise<LdpRoomsResult> {
  return new Promise((resolve, reject) => {
    let opened = false;
    let settled = false;
    let latest: any[] | null = null;
    const url = `${roomsUrl()}?access_token=${encodeURIComponent(token)}`;
    // Node's built-in WebSocket accepts handshake headers as a non-standard option.
    const ws: WebSocket = new (WebSocket as any)(url, { headers: { Origin: ORIGIN } });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          latest
            ? resolve({ rooms: mapUnits(latest), complete: false })
            : reject(new LdpRoomsError("timeout", `Room prices sent nothing within ${timeoutMs()}ms`)),
        ),
      timeoutMs(),
    );
    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify(message));
    };
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const units = msg?.data?.unit_details;
      if (Array.isArray(units)) latest = units;
      if (msg?.status === "success" || msg?.data?.streaming_status === "complete") {
        finish(() => resolve({ rooms: mapUnits(latest ?? []), complete: true }));
      } else if (msg?.statusCode && msg.statusCode !== 200) {
        const detail = String(msg?.message ?? "error").slice(0, 200);
        finish(() =>
          /no units/i.test(detail)
            ? resolve({ rooms: [], complete: true })
            : reject(new LdpRoomsError("unavailable", `Room prices error: ${detail}`)),
        );
      }
    };
    ws.onerror = () => {
      if (!opened) finish(() => reject(new HandshakeFailed()));
    };
    ws.onclose = (ev) => {
      finish(() =>
        latest
          ? resolve({ rooms: mapUnits(latest), complete: false })
          : reject(
              opened
                ? new LdpRoomsError("unavailable", `Room prices socket closed before results (code ${ev.code})`)
                : new HandshakeFailed(),
            ),
      );
    };
  });
}

/** Room offers for one hotel and stay. A refused handshake renews the JWT once. */
export async function getLdpRooms(req: LdpRoomsRequest): Promise<LdpRoomsResult> {
  const message = buildRoomsMessage(req);
  for (let attempt = 0; attempt < 2; attempt++) {
    let token: string;
    try {
      token = await getAccessToken();
    } catch (e) {
      if (e instanceof AuthError) throw new LdpRoomsError("unauthorized", e.message);
      throw e;
    }
    try {
      return await readRooms(message, token);
    } catch (e) {
      if (!(e instanceof HandshakeFailed)) throw e;
      if (attempt === 0) invalidateAccessToken();
    }
  }
  throw new LdpRoomsError("unauthorized", "Room prices socket refused the connection twice (check token and URL)");
}
