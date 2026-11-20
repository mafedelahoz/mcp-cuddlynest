// Room-groups socket (ldp-rooms.ts) tests. Offline: a local WebSocket server
// plays the LDP socket with a frame captured on staging
// (fixtures/staging-ldp-room-groups-sample.json), and a local HTTP server issues
// the JWT. Checks the message we send, the frame handling (partial / success /
// "No units" / timeout), the mapping to the scraper's room shape and the token retry.
//
// Run: npm test  (pretest builds dist/)

import http from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
};

const FRAME = JSON.parse(readFileSync("fixtures/staging-ldp-room-groups-sample.json", "utf8"));
const ACK = { message: "Hotel Rooms Search -> Socket Connection Established", statusCode: 200 };
const partial = { ...FRAME, status: "partial", data: { ...FRAME.data, streaming_status: undefined, unit_details: FRAME.data.unit_details.slice(0, 1) } };
const FAKE_JWT = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
  JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
).toString("base64url")}.sig`;

// JWT issuer
let tokenCalls = 0;
const issuer = http.createServer((req, res) => {
  tokenCalls++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ token: FAKE_JWT }));
});
await new Promise((r) => issuer.listen(0, "127.0.0.1", r));

// LDP socket: behaviour per `mode`
let mode = "ok";
let received = [];
let handshakes = 0;
const wss = new WebSocketServer({
  port: 0,
  host: "127.0.0.1",
  verifyClient: (info, cb) => {
    handshakes++;
    const token = new URL(info.req.url, "http://x").searchParams.get("access_token");
    if (mode === "reject-once" && handshakes === 1) return cb(false, 401);
    cb(token === FAKE_JWT, 401);
  },
});
await new Promise((r) => wss.on("listening", r));
wss.on("connection", (ws) => {
  ws.send(JSON.stringify(ACK));
  ws.on("message", (m) => {
    received.push(JSON.parse(String(m)));
    if (mode === "no-units") return ws.send(JSON.stringify({ statusCode: 400, message: "No units available for this property", data: null }));
    if (mode === "error") return ws.send(JSON.stringify({ statusCode: 500, message: "boom", data: null }));
    ws.send(JSON.stringify(partial));
    if (mode === "stall") return; // never completes
    setTimeout(() => ws.send(JSON.stringify(FRAME)), 20);
  });
});

Object.assign(process.env, {
  CUDDLYNEST_LDP_ROOMS_URL: `ws://127.0.0.1:${wss.address().port}/websocket/ldp_room_groups`,
  CUDDLYNEST_JWT_ISSUER_URL: `http://127.0.0.1:${issuer.address().port}/get-token`,
  CUDDLYNEST_API_KEY: "test-key-not-real",
  CUDDLYNEST_LDP_ROOMS_TIMEOUT_MS: "800",
});
const { buildRoomsMessage, getLdpRooms, isLdpRoomsEnabled, mapUnits, LdpRoomsError } = await import("./dist/ldp-rooms.js");
const { shapeUnit } = await import("./dist/cuddlynest.js");

const REQ = { productId: "3220156", checkin: "2027-01-12", checkout: "2027-01-14", adults: 2, children: 1, childAges: [1], infants: 0, rooms: 1, currency: "USD", location: "Cartagena, Colombia" };

console.log("\n=== Message and mapping ===");
const msg = buildRoomsMessage(REQ);
check("message mirrors the page's", msg.product_id === "3220156" && msg.listing_id === "3220156" && msg.type === "viewport" &&
  msg.location_type === "Hotel" && msg.childrenAges === "1" && msg.numberOfChildrenBelow2 === 1 && msg.numberOfChildrenBelow17 === 0);
const rooms = mapUnits(FRAME.data.unit_details);
check("one room offer per unit", rooms.length === FRAME.data.unit_details.length);
const deluxe = rooms.find((r) => r.partner_name === "ratehawk");
check("offer keeps price, partner, cancellation", deluxe.unit_price === 29 && deluxe.cancellation_policy?.type && deluxe.price_breakdown?.total);
check("booking options: one per rate with the Request to Book ids",
  deluxe.booking_options.length === 2 && deluxe.booking_options.every((o) => o.room_id && o.redis_key && o.room_redis_key && o.product_id));
const shaped = shapeUnit(deluxe, "USD", true);
check("shapes like a scraped unit, with bookingOptions[].offer",
  shaped.unitPrice === 29 && shaped.partnerName === "ratehawk" && shaped.bookingOptions[0].offer.roomId === deluxe.booking_options[0].room_id);

console.log("\n=== Socket ===");
check("enabled when URL and credentials are set", isLdpRoomsEnabled());
let r = await getLdpRooms(REQ);
check("waits for the success frame (all units, complete)", r.complete && r.rooms.length === FRAME.data.unit_details.length);
check("sends the message after the ack", received.at(-1)?.product_id === "3220156");

mode = "stall";
r = await getLdpRooms(REQ);
check("timeout after a partial frame: partial rooms, complete false", !r.complete && r.rooms.length === 1);

mode = "no-units";
r = await getLdpRooms(REQ);
check("\"No units available\" -> no rooms, not an error", r.complete && r.rooms.length === 0);

mode = "error";
let err;
try { await getLdpRooms(REQ); } catch (e) { err = e; }
check("other error frame -> LdpRoomsError unavailable", err instanceof LdpRoomsError && err.code === "unavailable");

mode = "reject-once"; handshakes = 0; const before = tokenCalls;
r = await getLdpRooms(REQ);
check("refused handshake renews the token and retries once", r.complete && handshakes === 2 && tokenCalls === before + 1);

delete process.env.CUDDLYNEST_LDP_ROOMS_URL;
check("disabled without CUDDLYNEST_LDP_ROOMS_URL (page scrape stays the default)", !isLdpRoomsEnabled());

wss.close();
issuer.close();
console.log(failures ? `\n❌ ${failures} ldp-rooms check(s) failed` : "\nldp-rooms: all cases passed");
process.exit(failures ? 1 : 0);
