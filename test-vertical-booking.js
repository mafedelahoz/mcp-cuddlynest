// Attractions (AO-83) and flights (AO-84) booking tests. Offline: mapping runs on
// real staging fixtures, calls go to a local mock of the shopping, booking and
// flight booking services. Checks mapping, validation, that supplier rates never
// leak, PII-safe logs, and tool gating.
//
// Run: npm test  (pretest builds dist/)

import http from "http";
import { readFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BookingError } from "./dist/booking.js";
import { mapAvailability, mapCheckout, mapPackage } from "./dist/attractions-booking.js";
import { buildPassengerList, mapFlightPrice, validatePassengers } from "./dist/flights-booking.js";

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
};
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const errorCode = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof BookingError ? e.code : "other";
  }
};

const ACTIVITY = "6936d5710f7de648237b1e12";
const PACKAGE = "6936d5720f7de648237b1e18";
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
console.log("attractions mapping (staging fixtures)");

const pkgBody = fixture("staging-attraction-packages-sample.json");
const pkg = mapPackage(pkgBody.packages[0], fixture("staging-attraction-skus-sample.json"), "2026-11-25");
check("package: id, title and cancellation", pkg.packageId === "6a843faacf0f7ab6c3478d43" && pkg.title === "Half Day Tour" && /full refund/.test(pkg.cancellation));
check("package: start times on the date as HH:MM", pkg.times[0] === "09:00" && pkg.times.every((t) => /^\d{2}:\d{2}$/.test(t)));
const adult = pkg.tickets.find((t) => t.type === "adult");
const infant = pkg.tickets.find((t) => t.type === "infant");
check("tickets: adult selling price, infant needs an adult", adult?.price?.amount === 220.5 && infant?.requiresAnyOf.includes("adult"));
check("options: supplier original_price never exposed", !JSON.stringify(pkg).includes("210"));

const avail = mapAvailability(fixture("staging-attraction-availability-sample.json"), { packageId: PACKAGE, date: "2026-11-25" });
check("availability: session id and confirmed total", avail.available && avail.sessionId && avail.total.amount === 2.14);
check("availability: per-ticket lines", avail.lines[0].count === 2 && avail.lines[0].unitPrice === 1.07);

const soldOut = mapAvailability(
  {
    success: false, error_code: "SOLD_OUT_FOR_DATE", supplier_code: "viator_not_available", supplier_trace_id: "tr-1",
    supplier_message: "raw supplier text", message: "Viator viator_not_available: No availability for the requested date/time/option",
  },
  { packageId: PACKAGE, date: "2026-11-25" },
);
check("unavailable: reason kept, supplier prefix stripped", !soldOut.available && soldOut.reason === "SOLD_OUT_FOR_DATE" && soldOut.message.startsWith("No availability"));
check("unavailable: supplier code / trace / message dropped", !/viator_not_available|tr-1|raw supplier/.test(JSON.stringify(soldOut)));
const needsTime = mapAvailability(
  { success: false, error_code: "TIME_SLOT_REQUIRED", available_times: ["17:00"], suggested_time: "17:00", message: "Please select a time slot." },
  { packageId: PACKAGE, date: "2026-11-25" },
);
check("time required: available times offered", !needsTime.available && needsTime.availableTimes[0] === "17:00");

const checkoutBody = fixture("staging-attraction-checkout-sample.json");
checkoutBody.price_details = { ...checkoutBody.price_details, supplier_total: "777.77", supplier_currency: "THB", fx_rate: "33.3" };
const co = mapCheckout(checkoutBody);
check("checkout: total, waived fee and cancellation", co.price.total === 2.14 && co.price.serviceFee === 0 && co.price.serviceFeeWaived && /Free cancellation/.test(co.cancellation));
check("checkout: lead traveler with required fields", co.travelers[0].isLead && co.travelers[0].fields.some((f) => f.key === "email" && f.required));
check("checkout: payment is a pending hand-off", co.payment.status === "handoff_pending");
check("checkout: supplier total, fx and partner fields dropped", !/777\.77|THB|33\.3|klook|40024/.test(JSON.stringify(co)));

// ---------------------------------------------------------------------------
console.log("flights mapping (staging fixture)");

const price = mapFlightPrice(fixture("staging-flight-price-sample.json").FlightPriceRS);
check("price: confirmed total, base, taxes and service fee", price.status === "Confirmed" && price.price.total.amount === 130.53 && price.price.base.amount === 103.86 && price.price.taxes.amount === 17 && price.price.serviceFee.amount === 9.67);
check("price: no change between search and re-price", price.priceChange.direction === "none");
check("price: fare rules and baggage", price.conditions.refundable === true && price.baggage[0].passengerType === "adult" && price.baggage[0].checked === 1);
check("price: supplier api_amount never exposed", !JSON.stringify(price).includes("999999.99") && !JSON.stringify(price).includes("api_"));
check("price: supplier name not exposed", !/duffel/i.test(JSON.stringify(price)));

const up = fixture("staging-flight-price-sample.json").FlightPriceRS;
up.Itinerary.Price.Updated.TotalAmount = { amount: 150.0, currency: "USD", api_amount: 1, api_currency: "USD" };
check("price: an increase requires acceptance", mapFlightPrice(up).priceChange.requiresAcceptance === true);
check("price: an expired session is session_expired", errorCode(() => mapFlightPrice({ Status: "Error", Error: { Message: "SessionExpired" } })) === "session_expired");
check("price: an unpriceable offer is an error", errorCode(() => mapFlightPrice({ Status: "Failed", Error: "Offer no longer available" })) === "room_unavailable");

const PAX = [{ type: "adult", title: "ms", firstName: "Simulated", lastName: "Passenger", gender: "f", dateOfBirth: "1990-05-01", nationality: "CO" }];
const CONTACT = {
  email: "simulated.passenger@example.com", phoneCountryCode: "+57", phoneNumber: "3001234567",
  address: { street: "Calle 1 # 2-3", city: "Bogota", state: "Cundinamarca", postalCode: "110111", country: "CO" },
};
check("passengers: valid input passes", validatePassengers(PAX, CONTACT).length === 0);
const bad = validatePassengers(
  [{ ...PAX[0], type: "child", firstName: "1x", gender: "x", dateOfBirth: day(2), document: { type: "passport", number: "X1", issuingCountry: "CO", expiryDate: day(-1) } }],
  { ...CONTACT, email: "nope", address: { ...CONTACT.address, postalCode: "" } },
);
check("passengers: bad name, gender, birth date, expired document, no adult, bad email, missing postal code", bad.length >= 7);
const list = buildPassengerList([...PAX, { ...PAX[0], type: "child", dateOfBirth: "2018-02-02" }], CONTACT);
check("passengers: only the lead adult carries the contact", list[0].ContactInfo?.Contact.Email === CONTACT.email && list[1].ContactInfo === null);

// ---------------------------------------------------------------------------
console.log("tools against a local mock (no real supplier calls)");

const seen = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const send = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const path = req.url.split("?")[0];
    if (path === "/v2/adp/check-availability") return send(200, fixture("staging-attraction-availability-sample.json"));
    if (path === "/v2/booking/checkout") return send(200, fixture("staging-attraction-checkout-sample.json"));
    if (path === "/api/flight/booking/price") return send(200, fixture("staging-flight-price-sample.json"));
    if (path === "/api/flight/booking/checkout") {
      const rs = fixture("staging-flight-price-sample.json").FlightPriceRS;
      return send(200, { FlightCheckoutRS: { ...rs, CNBookingID: "CNF-TEST-1" } });
    }
    send(404, { detail: "not found" });
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;

async function withServer(env, fn) {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: "node", args: ["dist/index.js"], stderr: "pipe",
    env: {
      ...process.env, IGNORE_ROBOTS_TXT: "true",
      CUDDLYNEST_ATTRACTIONS_API_URL: MOCK, CUDDLYNEST_ATTRACTIONS_BOOKING_API_URL: MOCK, CUDDLYNEST_FLIGHTS_BOOKING_API_URL: MOCK,
      ...env,
    },
  });
  transport.stderr?.on("data", (d) => stderr.push(String(d)));
  const client = new Client({ name: "vertical-booking-test", version: "0" });
  await client.connect(transport);
  try {
    return await fn(client, () => stderr.join(""));
  } finally {
    await client.close();
  }
}
const payload = (r) => JSON.parse(r.content[0].text);
const NEW_TOOLS = [
  "cuddlynest_attraction_options", "cuddlynest_attraction_availability", "cuddlynest_attraction_checkout",
  "cuddlynest_flight_price", "cuddlynest_flight_checkout",
];

await withServer({ CUDDLYNEST_ENABLE_BOOKING_TOOLS: "" }, async (client) => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  check("disabled by default: attraction/flight booking tools not listed", !NEW_TOOLS.some((n) => names.includes(n)));
  let refused = false;
  try {
    refused = !!(await client.callTool({ name: "cuddlynest_flight_price", arguments: { sessionId: "s", flightId: "f" } })).isError;
  } catch {
    refused = true;
  }
  check("disabled: calling one is refused and nothing is sent", refused && seen.length === 0);
});

await withServer({ CUDDLYNEST_ENABLE_BOOKING_TOOLS: "true" }, async (client, logs) => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  check("enabled: all five tools listed", NEW_TOOLS.every((n) => names.includes(n)));

  const a = payload(await client.callTool({
    name: "cuddlynest_attraction_availability",
    arguments: { activityId: ACTIVITY, packageId: PACKAGE, date: day(10), time: "17:00", tickets: [{ skuId: "822428064800", count: 2 }] },
  }));
  const sent = seen.find((s) => s.url === "/v2/adp/check-availability")?.body;
  check("availability: date + time sent as one start_time", sent?.start_time === `${day(10)} 17:00:00` && sent?.sku_list[0].count === 2);
  check("availability: answers the session id", a.available && a.sessionId);

  const badIds = await client.callTool({ name: "cuddlynest_attraction_availability", arguments: { activityId: "x", packageId: PACKAGE, date: day(10), tickets: [{ skuId: "1", count: 1 }] } });
  check("availability: bad ids refused before any call", badIds.isError && payload(badIds).bookingErrorCode === "invalid_input" && seen.length === 1);

  const c = payload(await client.callTool({ name: "cuddlynest_attraction_checkout", arguments: { sessionId: a.sessionId, activityId: ACTIVITY, packageId: PACKAGE } }));
  check("attraction checkout: total and pending hand-off", c.price.total === 2.14 && c.payment.status === "handoff_pending");

  const p = payload(await client.callTool({ name: "cuddlynest_flight_price", arguments: { sessionId: "sess-1", flightId: "off_1" } }));
  check("flight price: confirmed total", p.price.total.amount === 130.53 && !JSON.stringify(p).includes("999999.99"));

  const before = seen.length;
  const invalid = await client.callTool({ name: "cuddlynest_flight_checkout", arguments: { sessionId: "sess-1", flightId: "off_1", passengers: [{ ...PAX[0], gender: "x" }], contact: CONTACT } });
  check("flight checkout: invalid passenger refused before any call", invalid.isError && seen.length === before);

  const fc = payload(await client.callTool({ name: "cuddlynest_flight_checkout", arguments: { sessionId: "sess-1", flightId: "off_1", passengers: PAX, contact: CONTACT } }));
  check("flight checkout: pending booking id and hand-off", fc.bookingId === "CNF-TEST-1" && fc.payment.status === "handoff_pending");
  const sentPax = seen.find((s) => s.url === "/api/flight/booking/checkout")?.body?.FlightCheckoutRQ;
  check("flight checkout: passengers and contact sent to the engine", sentPax?.PassengerList[0].FirstName === "Simulated" && sentPax?.ContactInfo.Address.City === "Bogota");

  const text = logs();
  check("logs: no passenger names, email, phone or address", text.includes("Flight checkout created") && !/Simulated|Passenger|simulated\.passenger|3001234567|Calle 1/.test(text));
});

mock.close();
console.log(failures ? `\n❌ ${failures} vertical booking check(s) failed` : "\nvertical booking: all cases passed");
process.exit(failures ? 1 : 0);
