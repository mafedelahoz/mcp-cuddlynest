// Offline tests for the listing scraper:
//   1. buildListingUrl  — pure, no browser
//   2. extractRoomsFromDom — launches a LOCAL headless Chromium (no network) against
//      a synthetic page rebuilt from the real captured fixture, and checks the
//      React-fiber walk reconstructs the captured room/price/cancellation data.
//
// Run: npm test  (pretest builds dist/)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildListingUrl, __internal } from "./dist/scrape-listing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "hotel-sansiraka-2026-10-05.json"), "utf8"),
);

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
};

// --- 1. buildListingUrl ----------------------------------------------------
console.log("\n=== buildListingUrl ===");
{
  const parsed = new URL(
    buildListingUrl({
      productId: "4395541",
      listingPath: "co/hotel-sansiraka-4395541",
      checkin: "2026-10-05",
      checkout: "2026-10-08",
      adults: 2,
      children: 1,
      childrenAges: [2],
      infants: 0,
      rooms: 1,
      currency: "COP",
    }),
  );
  check(
    "canonical path",
    parsed.origin + parsed.pathname === "https://www.cuddlynest.com/hotel/co/hotel-sansiraka-4395541",
  );
  check("checkin", parsed.searchParams.get("checkin") === "2026-10-05");
  check("checkout", parsed.searchParams.get("checkout") === "2026-10-08");
  check("adults", parsed.searchParams.get("adults") === "2");
  check("children", parsed.searchParams.get("children") === "1");
  check("childrenAges", parsed.searchParams.get("childrenAges") === "2");
  check("infants", parsed.searchParams.get("infants") === "0");
  check("rooms", parsed.searchParams.get("rooms") === "1");
  check("currency", parsed.searchParams.get("currency") === "COP");
}
{
  const parsed = new URL(
    buildListingUrl({
      productId: "4395541",
      listingPath: "co/hotel-sansiraka-4395541",
      checkin: "2026-10-05",
      checkout: "2026-10-08",
      adults: 2,
    }),
  );
  check("defaults children=0", parsed.searchParams.get("children") === "0");
  check("defaults infants=0", parsed.searchParams.get("infants") === "0");
  check("defaults rooms=1", parsed.searchParams.get("rooms") === "1");
  check("defaults currency=USD", parsed.searchParams.get("currency") === "USD");
  check("no childrenAges when omitted", !parsed.searchParams.has("childrenAges"));
}

// --- 2. extractRoomsFromDom against the real fixture (offline) ------------
console.log("\n=== extractRoomsFromDom (real fixture, offline, local Chromium) ===");
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("  ⚠️  playwright not installed — skipping DOM test (run `npx playwright install chromium`)");
  process.exit(failures ? 1 : 0);
}

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
} catch (e) {
  console.log(`  ⚠️  could not launch Chromium (${e.message}) — skipping DOM test`);
  process.exit(failures ? 1 : 0);
}

try {
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');
  // Rebuild the real page's DOM + React-fiber shape from the captured fixture.
  await page.evaluate((rooms) => {
    const root = document.getElementById("root");
    // Room groups as the live page shapes them (values simulated): a policy group
    // whose `extras` are the bookable rates (meal plans).
    const groups = [{
      group_title: "Non-refundable", cancellation_policy_type: "non_refundable", record_id: 22,
      id: "sim-group", redis_key: "sim_rk", room_redis_key: "sim_rrk",
      extras: [
        { product_id: "1_9000001", id: "sim-rate-a", record_id: 22, redis_key: "sim_rk", room_redis_key: "sim_rrk", extra_type: "no_meal", extra_title: "No Meal Included", unit_price: 384 },
        { product_id: "1_9000001", id: "sim-rate-b", record_id: 22, redis_key: "sim_rk", extra_type: "breakfast", extra_title: "Breakfast", unit_price: 410 },
      ],
    }];
    for (const [i, room] of rooms.entries()) {
      const wrapper = document.createElement("div");
      const priceSpan = document.createElement("span");
      priceSpan.textContent = `COL$${room.unit_price}`;
      wrapper.appendChild(priceSpan);
      root.appendChild(wrapper);
      // Mirror React: fiber on the DOM element, room props one `.return` up,
      // with the `roomGroups` key the detector also checks for.
      priceSpan.__reactFiber$test = {
        memoizedProps: { className: "price-leaf" },
        return: { memoizedProps: { ...room, roomGroups: i === 0 ? groups : {} }, return: null },
      };
    }
    const fromDiv = document.createElement("div");
    fromDiv.innerHTML = "<span>From</span><span>COL$742,637</span>";
    root.appendChild(fromDiv);
  }, fixture.rooms);

  const result = await page.evaluate(__internal.extractRoomsFromDom);

  check(`recovered all ${fixture.rooms.length} room offers`, result.rooms.length === fixture.rooms.length);

  const key = (r) => `${r.title}|${r.partner_name}`;
  const got = new Map(result.rooms.map((r) => [key(r), r]));
  for (const exp of fixture.rooms) {
    const act = got.get(key(exp));
    check(
      `${key(exp)} — price/product/rooms/cancellation`,
      !!act &&
        act.unit_price === exp.unit_price &&
        act.product_id === exp.product_id &&
        act.remaining_rooms === exp.remaining_rooms &&
        act.cancellation_policy.type === exp.cancellation_policy.type &&
        JSON.stringify(act.cancellation_policy.text) === JSON.stringify(exp.cancellation_policy.text) &&
        act.price_breakdown.total.amount === exp.price_breakdown.total.amount,
    );
  }

  const suite = result.rooms.find((r) => r.title === "Standard Suite" && r.partner_name === "hxpro");
  check(
    "Standard Suite (hxpro) free-cancellation text verbatim",
    !!suite &&
      suite.cancellation_policy.type === "Free Cancellation" &&
      JSON.stringify(suite.cancellation_policy.text) ===
        JSON.stringify([
          "Receive a 100% refund for your booking if you cancel before 02 October 2026 11:59 PM",
          "Receive a 67% refund for your booking if you cancel before 05 October 2026 11:59 PM",
          "The cancellation policy time zone is in the property's local time zone.",
        ]),
  );

  check("fromPriceText picked up", result.fromPriceText === "COL$742,637");

  const opts = result.rooms.find((r) => r.title === fixture.rooms[0].title && r.partner_name === fixture.rooms[0].partner_name)?.booking_options ?? [];
  check(
    "booking options: one per rate, with the Request to Book ids",
    opts.length === 2 &&
      opts[0].room_id === "sim-rate-a" && opts[0].product_id === "1_9000001" && opts[0].redis_key === "sim_rk" &&
      opts[0].room_redis_key === "sim_rrk" && opts[0].record_id === 22 && opts[0].group_title === "Non-refundable" &&
      opts[1].extra_title === "Breakfast" && opts[1].room_redis_key === "sim_rrk",
  );
  check("rooms without groups have no booking options", result.rooms.filter((r) => r.booking_options?.length).length === 1);
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall cases passed");
process.exit(failures ? 1 : 0);
