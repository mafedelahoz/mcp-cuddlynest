// Booking flow (AO-16) tests. Offline: the backend booking contract isn't known
// yet, so the flow runs against a FAKE in-test provider. This checks our side of
// the flow (validation, ordering, expiry, price changes, PII-safe logs, tool
// gating), not the real backend.
//
// Run: npm test  (pretest builds dist/)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  BookingError,
  BookingFlow,
  comparePrices,
  pendingBookingProvider,
  redactGuest,
  validateGuest,
  validateStay,
} from "./dist/booking.js";

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
const ROOM = { productId: "9000001", searchId: "s-1", roomContractSetId: "rcs-1", redisKey: "rk-1" };
const GUEST = {
  firstName: "Simulated", lastName: "Guestperson", email: "simulated.guest@example.com",
  phoneCountryCode: "+57", phoneNumber: "3001234567", country: "CO", dateOfBirth: "1990-05-01",
};

// Fake provider: prices the room at 300, pre-book returns whatever `prebookTotal` says.
function fakeProvider(prebookTotal = 300) {
  const calls = { quote: 0, prebook: 0, checkout: 0, status: 0 };
  return {
    calls,
    provider: {
      name: "fake",
      async quote(room, stay) {
        calls.quote++;
        return { room, stay, total: { amount: 300, currency: stay.currency }, cancellation: { refundable: true } };
      },
      async prebook() {
        calls.prebook++;
        return { total: { amount: prebookTotal, currency: "USD" } };
      },
      async createCheckout(prebook) {
        calls.checkout++;
        return { checkoutUrl: `https://www.cuddlynest.com/checkout/fake-${prebook.prebookId}`, bookingReference: "CN-FAKE-1" };
      },
      async getStatus(ref) {
        calls.status++;
        return { bookingReference: ref, status: "booked" };
      },
    },
  };
}

console.log("\n=== validateStay / validateGuest ===");
check("valid stay passes", validateStay(STAY).length === 0);
check("past checkin rejected", validateStay({ ...STAY, checkin: day(-1) }).some((e) => e.includes("past")));
check("checkout before checkin rejected", validateStay({ ...STAY, checkout: STAY.checkin }).some((e) => e.includes("after")));
check("impossible date (Feb 30) rejected", validateStay({ ...STAY, checkin: "2027-02-30" }).length > 0);
check("more rooms than adults rejected", validateStay({ ...STAY, rooms: 3 }).some((e) => e.includes("adult")));
check("childAges must match children", validateStay({ ...STAY, childAges: [] }).length > 0);
check("bad currency rejected", validateStay({ ...STAY, currency: "usd" }).length > 0);
check("valid guest passes", validateGuest(GUEST).length === 0);
check("bad email rejected", validateGuest({ ...GUEST, email: "nope" }).length > 0);
check("minor lead guest rejected", validateGuest({ ...GUEST, dateOfBirth: day(-365 * 10) }).some((e) => e.includes("18")));
check("country must be ISO alpha-2", validateGuest({ ...GUEST, country: "Colombia" }).length > 0);

console.log("\n=== redactGuest / comparePrices ===");
const red = JSON.stringify(redactGuest(GUEST));
check("redacted guest hides name, email user and phone",
  !red.includes("Simulated") && !red.includes("Guestperson") && !red.includes("simulated.guest") && !red.includes("3001234567"));
check("rounding-size difference is not a change", comparePrices({ amount: 300, currency: "USD" }, { amount: 300.01, currency: "USD" }).direction === "none");
const up = comparePrices({ amount: 300, currency: "USD" }, { amount: 330, currency: "USD" });
check("price up 10% needs acceptance", up.direction === "up" && up.requiresAcceptance && up.percent === 10);
check("price down doesn't need acceptance", !comparePrices({ amount: 300, currency: "USD" }, { amount: 270, currency: "USD" }).requiresAcceptance);
check("currency mismatch always needs acceptance", comparePrices({ amount: 300, currency: "USD" }, { amount: 300, currency: "EUR" }).requiresAcceptance);

console.log("\n=== BookingFlow with a FAKE provider ===");
{
  const logs = [];
  const { provider, calls } = fakeProvider(300);
  const flow = new BookingFlow(provider, { log: (...a) => logs.push(JSON.stringify(a)) });
  const quote = await flow.quote(ROOM, STAY);
  const prebook = await flow.prebook(quote.quoteId);
  const r = await flow.checkout(prebook.prebookId, { guest: GUEST });
  check("happy path: quote -> prebook -> checkout link", r.handoff.checkoutUrl.includes("/checkout/") && calls.checkout === 1);
  check("unchanged price needs no acceptance", !prebook.priceChange.requiresAcceptance);
  check("status goes through the provider", (await flow.status("CN-FAKE-1")).status === "booked");
  const allLogs = logs.join("\n");
  check("logs never contain guest PII",
    !allLogs.includes("Guestperson") && !allLogs.includes("simulated.guest") && !allLogs.includes("3001234567"));
}
{
  const { provider, calls } = fakeProvider(345);
  const flow = new BookingFlow(provider);
  const prebook = await flow.prebook((await flow.quote(ROOM, STAY)).quoteId);
  check("price went up 15% -> flagged", prebook.priceChange.direction === "up" && prebook.priceChange.requiresAcceptance);
  check("checkout refused until the user accepts",
    await expectCode(() => flow.checkout(prebook.prebookId), "price_change_not_accepted") && calls.checkout === 0);
  const r = await flow.checkout(prebook.prebookId, { acceptPriceChange: true });
  check("checkout proceeds after acceptance", r.total.amount === 345 && calls.checkout === 1);
}
{
  let now = Date.now();
  const { provider, calls } = fakeProvider();
  const flow = new BookingFlow(provider, { now: () => now });
  const quote = await flow.quote(ROOM, STAY);
  now += 16 * 60_000; // past the 15-minute default quote TTL
  check("expired quote can't be pre-booked", await expectCode(() => flow.prebook(quote.quoteId), "quote_expired") && calls.prebook === 0);
  check("unknown quoteId rejected", await expectCode(() => flow.prebook("nope"), "quote_not_found"));
  check("unknown prebookId rejected", await expectCode(() => flow.checkout("nope"), "prebook_not_found"));
}
{
  const { provider, calls } = fakeProvider();
  const flow = new BookingFlow(provider);
  check("invalid stay rejected before calling the provider",
    await expectCode(() => flow.quote(ROOM, { ...STAY, checkin: day(-2) }), "invalid_input") && calls.quote === 0);
  check("missing room ids rejected", await expectCode(() => flow.quote({ productId: "1" }, STAY), "invalid_input"));
  const prebook = await flow.prebook((await flow.quote(ROOM, STAY)).quoteId);
  check("invalid guest rejected before checkout is created",
    await expectCode(() => flow.checkout(prebook.prebookId, { guest: { ...GUEST, email: "x" } }), "invalid_input") && calls.checkout === 0);
}
check("pending provider answers contract_pending",
  await expectCode(() => new BookingFlow(pendingBookingProvider).quote(ROOM, STAY), "contract_pending"));

console.log("\n=== MCP server: booking tools are gated ===");
async function withServer(env, fn) {
  const capture = env.__CAPTURE_STDERR === "1";
  const transport = new StdioClientTransport({
    command: "node", args: ["dist/index.js"], stderr: capture ? "pipe" : "ignore",
    env: { ...process.env, IGNORE_ROBOTS_TXT: "true", ...env },
  });
  if (capture) transport.stderr?.on("data", (d) => stderrChunks.push(String(d)));
  const client = new Client({ name: "booking-test", version: "0" });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close(); }
}
await withServer({ CUDDLYNEST_ENABLE_BOOKING_TOOLS: "" }, async (client) => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  check("disabled by default: booking tools not listed", !names.some((n) => n.startsWith("cuddlynest_booking_")));
  let refused = false;
  try {
    const r = await client.callTool({ name: "cuddlynest_booking_quote", arguments: { ...ROOM, ...STAY } });
    refused = !!r.isError;
  } catch {
    refused = true;
  }
  check("disabled: calling a booking tool is refused", refused);
});
// Server stderr captured to check the generic "Tool call received" log masks guest PII.
const stderrChunks = [];
await withServer({ CUDDLYNEST_ENABLE_BOOKING_TOOLS: "true", __CAPTURE_STDERR: "1" }, async (client) => {
  const leak = await client.callTool({ name: "cuddlynest_booking_checkout", arguments: { prebookId: "nope", guest: GUEST } });
  check("enabled: unknown prebook -> prebook_not_found", JSON.parse(leak.content[0].text).bookingErrorCode === "prebook_not_found");

  const names = (await client.listTools()).tools.map((t) => t.name);
  check("enabled: 4 booking tools listed", names.filter((n) => n.startsWith("cuddlynest_booking_")).length === 4);
  const r = await client.callTool({ name: "cuddlynest_booking_quote", arguments: { ...ROOM, ...STAY } });
  const j = JSON.parse(r.content[0].text);
  check("enabled: quote answers contract_pending (no backend yet)", r.isError && j.bookingErrorCode === "contract_pending");
  const bad = await client.callTool({ name: "cuddlynest_booking_quote", arguments: { ...ROOM, ...STAY, checkin: day(-3) } });
  check("enabled: invalid input caught before the provider", JSON.parse(bad.content[0].text).bookingErrorCode === "invalid_input");
});
const serverLog = stderrChunks.join("");
check("server logs captured", serverLog.includes("Tool call received"));
check("server logs never contain guest PII",
  !serverLog.includes("Guestperson") && !serverLog.includes("simulated.guest") && !serverLog.includes("3001234567"));

console.log(failures ? `\n❌ ${failures} booking check(s) failed` : "\nbooking: all cases passed");
process.exit(failures ? 1 : 0);
