// Stays booking (AO-82) tests. Offline: Request to Book, the checkout side widget,
// booking status and the JWT issuer are a local mock answering with responses
// captured on staging (fixtures/staging-stays-*). Checks the query we send, the
// response mapping, errors, token retry and tool gating.
//
// Run: npm test  (pretest builds dist/)

import http from "node:http";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
};
const expectCode = async (fn, code) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return e instanceof BookingError && e.code === code;
  }
};

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const STAY = { checkin: day(20), checkout: day(23), adults: 2, children: 1, childAges: [7], infants: 0, rooms: 1, currency: "USD" };
const OFFER = { productId: "3234329_9000001", roomId: "sim-room-1", recordId: "22", redisKey: "sim_rk_1", roomRedisKey: "sim_rrk_1" };
const FAKE_JWT = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
  JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
).toString("base64url")}.sig`;

const fixture = (name) => JSON.parse(readFileSync(`fixtures/staging-stays-${name}-sample.json`, "utf8"));
const RTB = fixture("request-to-book");
const WIDGET = fixture("side-widget");
const STATUS = fixture("booking-status");
const ENQ = String(RTB.data.enId);
const REF = STATUS.data.booking_no;

// Mock: /get-token issues FAKE_JWT; request_to_book answers per `mode`.
let mode = "ok";
let rtbCalls = [];
let tokenCalls = 0;
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/get-token") {
    tokenCalls++;
    return json(200, { token: FAKE_JWT });
  }
  if (url.pathname === "/api/v1/product/request_to_book") {
    rtbCalls.push({ query: url.searchParams, auth: req.headers["x-authorization"] });
    if (mode === "unauthorized-once" && rtbCalls.length === 1) return json(401, { detail: "expired" });
    if (mode === "sold-out") return json(200, { statusCode: 200, message: "Sold out", data: { status: true, price_changed: false, message: "Sold out" } });
    if (mode === "foreign-url") return json(200, { statusCode: 200, message: "ok", data: { url: "https://evil.example.com/pay", enId: 1 } });
    if (mode === "422") return json(422, { detail: [{ loc: ["query", "checkin"], msg: "Field required", type: "missing" }] });
    if (mode === "500") return json(500, { detail: "boom" });
    return json(200, RTB);
  }
  if (url.pathname === "/api/v1/checkoutpage/side_widget_detail") {
    if (mode === "widget-down") return json(500, {});
    return json(200, WIDGET);
  }
  if (url.pathname === "/api/v1/checkoutpage/booking_status") {
    if (url.searchParams.get("booking_id") !== ENQ) return json(404, { statusCode: 404, status: "Not Found", data: null });
    return json(200, STATUS);
  }
  json(404, {});
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;
const MOCK_ENV = {
  CUDDLYNEST_REQUEST_TO_BOOK_API_URL: MOCK,
  CUDDLYNEST_CHECKOUT_SIDE_WIDGET_API_URL: MOCK,
  CUDDLYNEST_CHECKOUT_CONFIRM_BOOKING_API_URL: MOCK,
  CUDDLYNEST_CHECKOUT_SITE_URL: "https://staging.cuddlynest.com",
  CUDDLYNEST_JWT_ISSUER_URL: `${MOCK}/get-token`,
  CUDDLYNEST_API_KEY: "test-key-not-real",
};
Object.assign(process.env, MOCK_ENV);

const { BookingError, buildRequestToBookQuery, comparePrices, getStayBookingStatus, mapBookingStatus, mapRequestToBook, mapSideWidget, requestToBook, validateOffer, validateStay } =
  await import("./dist/booking.js");

console.log("\n=== Validation ===");
check("valid stay passes", validateStay(STAY).length === 0);
check("past checkin rejected", validateStay({ ...STAY, checkin: day(-1) }).some((e) => e.includes("past")));
check("checkout before checkin rejected", validateStay({ ...STAY, checkout: STAY.checkin }).some((e) => e.includes("after")));
check("impossible date (Feb 30) rejected", validateStay({ ...STAY, checkin: "2027-02-30" }).length > 0);
check("more rooms than adults rejected", validateStay({ ...STAY, rooms: 3 }).some((e) => e.includes("adult")));
check("childAges must match children", validateStay({ ...STAY, childAges: [] }).length > 0);
check("bad currency rejected", validateStay({ ...STAY, currency: "usd" }).length > 0);
check("valid offer passes", validateOffer(OFFER).length === 0);
check("offer needs roomId", validateOffer({ ...OFFER, roomId: "" }).length > 0);
check("redis keys are optional (own units have none)", validateOffer({ productId: "1", roomId: "r" }).length === 0);

console.log("\n=== Price changes (flights re-price) ===");
check("rounding-size difference is not a change", comparePrices({ amount: 300, currency: "USD" }, { amount: 300.01, currency: "USD" }).direction === "none");
const up = comparePrices({ amount: 300, currency: "USD" }, { amount: 330, currency: "USD" });
check("price up 10% needs acceptance", up.direction === "up" && up.requiresAcceptance && up.percent === 10);
check("currency mismatch always needs acceptance", comparePrices({ amount: 300, currency: "USD" }, { amount: 300, currency: "EUR" }).requiresAcceptance);

console.log("\n=== Request to Book: query and mapping ===");
const q = buildRequestToBookQuery(OFFER, STAY);
check("query carries the rate ids", q.get("product_id") === OFFER.productId && q.get("room_id") === OFFER.roomId &&
  q.get("redis_key") === OFFER.redisKey && q.get("room_redis_key") === OFFER.roomRedisKey && q.get("record_id") === "22");
check("guests = adults + children", q.get("guests") === "3" && q.get("adults") === "2" && q.get("children") === "1");
check("child ages as child_ages[]", q.getAll("child_ages[]").join() === "7");
check("never sends mock_*, platform or session_id", ![...q.keys()].some((k) => k.startsWith("mock_") || k === "platform" || k === "session_id"));
const mapped = mapRequestToBook(RTB, "https://www.cuddlynest.com");
check("relative staging url -> absolute link on the site", mapped.checkoutUrl === `https://www.cuddlynest.com/${RTB.data.url}` && mapped.enquiryId === ENQ);
check("\"Sold out\" (statusCode 200, no url) -> room_unavailable",
  await expectCode(async () => mapRequestToBook({ statusCode: 200, message: "Sold out", data: { message: "Sold out" } }), "room_unavailable"));
check("non-https link refused",
  await expectCode(async () => mapRequestToBook({ statusCode: 200, data: { url: "http://www.cuddlynest.com/c", enId: 1 } }), "provider_error"));
check("lookalike host refused",
  await expectCode(async () => mapRequestToBook({ statusCode: 200, data: { url: "https://cuddlynest.com.evil.io/c", enId: 1 } }), "provider_error"));
const w = mapSideWidget(WIDGET, "USD");
check("side widget: total, bill lines and cancellation", w.price.total.amount === 29.71 && w.price.total.currency === "USD" &&
  w.price.lines.some((l) => l.name === "Taxes and fees") && w.cancellation.type === "Free Cancellation" &&
  w.cancellation.firstRefundDate === "Jan 10, 2027" && w.cancellation.policies.length === 3);
check("side widget: no supplier/debug data", !JSON.stringify(w).includes("999999.99") && !JSON.stringify(w).includes("book_hash"));
const st = mapBookingStatus(STATUS);
check("status: Pending -> pending, booking number and dates", st.status === "pending" && st.bookingReference === REF && st.checkin === "2027-01-12");
check("status: Cancelled -> cancelled, Dismissed -> declined",
  mapBookingStatus({ status: "Cancelled", data: {} }).status === "cancelled" && mapBookingStatus({ status: "Dismissed", data: {} }).status === "declined");

console.log("\n=== Request to Book: against the local mock ===");
const logs = [];
const log = (level, message, data) => logs.push(JSON.stringify({ level, message, data }));
const r = await requestToBook(OFFER, STAY, { log });
check("happy path: link, enquiry id, booking number, price, cancellation",
  r.checkoutUrl === `https://staging.cuddlynest.com/${RTB.data.url}` && r.enquiryId === ENQ && r.bookingReference === REF &&
  r.price.total.amount === 29.71 && r.cancellation.type === "Free Cancellation");
check("sends the JWT as Bearer in X-Authorization", rtbCalls.at(-1).auth === `Bearer ${FAKE_JWT}`);
check("answers only the mapped fields", Object.keys(r).sort().join() === "bookingReference,cancellation,checkoutUrl,enquiryId,price");
check("logs the booking reference, not the JWT", logs.some((l) => l.includes(REF)) && !logs.join().includes(FAKE_JWT));

mode = "unauthorized-once"; rtbCalls = []; const tokensBefore = tokenCalls;
const retried = await requestToBook(OFFER, STAY);
check("401 refreshes the token and retries once", retried.enquiryId === ENQ && rtbCalls.length === 2 && tokenCalls === tokensBefore + 1);
mode = "widget-down";
const noWidget = await requestToBook(OFFER, STAY);
check("side widget down: still returns the link, price null", noWidget.checkoutUrl.includes("booking-payment") && noWidget.price === null);
mode = "sold-out";
check("unavailable rate -> room_unavailable", await expectCode(() => requestToBook(OFFER, STAY), "room_unavailable"));
mode = "foreign-url";
check("checkout link outside cuddlynest.com refused", await expectCode(() => requestToBook(OFFER, STAY), "provider_error"));
mode = "422";
check("422 -> invalid_input", await expectCode(() => requestToBook(OFFER, STAY), "invalid_input"));
mode = "500";
check("500 -> provider_error", await expectCode(() => requestToBook(OFFER, STAY), "provider_error"));
mode = "ok"; rtbCalls = [];
check("invalid stay rejected before calling the API",
  await expectCode(() => requestToBook(OFFER, { ...STAY, checkin: day(-3) }), "invalid_input") && rtbCalls.length === 0);
check("status by enquiry id + matching booking number", (await getStayBookingStatus(ENQ, REF.toLowerCase())).status === "pending");
check("status refuses a mismatched booking number", await expectCode(() => getStayBookingStatus(ENQ, "SCN0000000"), "invalid_input"));
check("status refuses an unknown enquiry id", await expectCode(() => getStayBookingStatus("123", REF), "invalid_input"));
check("status needs a numeric enquiry id", await expectCode(() => getStayBookingStatus("abc", REF), "invalid_input"));

console.log("\n=== MCP server: booking tools are gated ===");
async function withServer(env, fn) {
  const transport = new StdioClientTransport({
    command: "node", args: ["dist/index.js"], stderr: "ignore",
    env: { ...process.env, IGNORE_ROBOTS_TXT: "true", ...env },
  });
  const client = new Client({ name: "booking-test", version: "0" });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close(); }
}
await withServer({ CUDDLYNEST_ENABLE_BOOKING_TOOLS: "" }, async (client) => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  check("disabled by default: booking tools not listed", !names.some((n) => n.startsWith("cuddlynest_booking_")));
  let refused = false;
  try {
    const res = await client.callTool({ name: "cuddlynest_booking_checkout", arguments: { offer: OFFER, ...STAY } });
    refused = !!res.isError;
  } catch {
    refused = true;
  }
  check("disabled: calling a booking tool is refused", refused && rtbCalls.length === 0);
});
await withServer({ CUDDLYNEST_ENABLE_BOOKING_TOOLS: "true", ...MOCK_ENV }, async (client) => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  check("enabled: checkout and status listed, no quote/prebook",
    names.includes("cuddlynest_booking_checkout") && names.includes("cuddlynest_booking_status") &&
    !names.some((n) => /quote|prebook/.test(n)));
  const res = await client.callTool({ name: "cuddlynest_booking_checkout", arguments: { offer: OFFER, ...STAY } });
  const j = JSON.parse(res.content[0].text);
  check("enabled: checkout returns link and price through the tool",
    !res.isError && j.checkoutUrl.includes("booking-payment") && j.price.total.amount === 29.71 && j.payment.status === "handoff");
  const bad = await client.callTool({ name: "cuddlynest_booking_checkout", arguments: { offer: OFFER, ...STAY, checkin: day(-3) } });
  check("enabled: invalid input caught before the API", JSON.parse(bad.content[0].text).bookingErrorCode === "invalid_input");
  const st = await client.callTool({ name: "cuddlynest_booking_status", arguments: { enquiryId: ENQ, bookingReference: REF } });
  check("enabled: status through the tool", !st.isError && JSON.parse(st.content[0].text).status === "pending");
});

mock.close();
console.log(failures ? `\n❌ ${failures} booking check(s) failed` : "\nbooking: all cases passed");
process.exit(failures ? 1 : 0);
