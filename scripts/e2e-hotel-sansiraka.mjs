#!/usr/bin/env node
/**
 * End-to-end check against the REAL cuddlynest.com.
 *
 * Not part of `npm test` — it needs real internet egress and downloads a page
 * in a headless browser (~10-20s). Run from a machine/CI with network access:
 *
 *   npm run e2e:sansiraka
 *
 * Validated case: Hotel Sansiraka (product_id 4395541), 2026-10-05 -> 2026-10-08,
 * 2 adults + 1 child age 2, COP. Prices are live and will drift from the fixture;
 * we assert on STRUCTURE, not exact amounts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveListingPath, scrapeListing } from "../dist/scrape-listing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "hotel-sansiraka-2026-10-05.json"), "utf8"),
);

const params = {
  productId: "4395541",
  checkin: "2026-10-05",
  checkout: "2026-10-08",
  adults: 2,
  children: 1,
  childrenAges: [2],
  infants: 0,
  rooms: 1,
  currency: "COP",
};

const log = (l, m, d) => console.error(`[${l}]`, m, d ?? "");

console.log("Resolving listing path for", params.productId, "...");
params.listingPath = await resolveListingPath(params.productId);
console.log("  ->", params.listingPath);

console.log("Scraping listing page (headless)...");
const result = await scrapeListing(params, {
  headless: true,
  timeoutMs: 45000,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  log,
});

console.log("\n=== RESULT ===");
console.log("URL:", result.url);
console.log("From price shown on page:", result.fromPriceText);
console.log("Rooms found:", result.rooms.length);
for (const r of result.rooms) {
  console.log(
    `  - ${r.title} / ${r.partner_name}: ${r.unit_price} ${params.currency} ` +
      `| left ${r.remaining_rooms} | ${r.cancellation_policy?.type}`,
  );
}

// ---- structural assertions --------------------------------------------------
let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures++;
};

console.log("\n=== STRUCTURE vs fixture (fixtures/hotel-sansiraka-2026-10-05.json) ===");
check("at least one room returned", result.rooms.length > 0);
check(
  "every room has the fixture's key shape",
  result.rooms.every(
    (r) =>
      typeof r.title === "string" &&
      typeof r.partner_name === "string" &&
      typeof r.unit_price === "number" &&
      typeof r.remaining_rooms === "number" &&
      r.price_breakdown &&
      typeof r.price_breakdown.total?.amount === "number" &&
      r.cancellation_policy &&
      typeof r.cancellation_policy.type === "string" &&
      Array.isArray(r.cancellation_policy.text) &&
      Array.isArray(r.room_filters),
  ),
);
const fixtureKeys = Object.keys(fixture.rooms[0]).sort().join(",");
check(
  `room object keys match fixture (${fixtureKeys})`,
  result.rooms.every((r) => Object.keys(r).sort().join(",") === fixtureKeys),
);
const livePartners = [...new Set(result.rooms.map((r) => r.partner_name))].sort();
const fixturePartners = [...new Set(fixture.rooms.map((r) => r.partner_name))].sort();
console.log("  live partners:   ", livePartners.join(", "));
console.log("  fixture partners:", fixturePartners.join(", "));
console.log(
  "  (room count / partner set drift from the fixture is EXPECTED — live inventory)",
);
// fromPriceText comes from a more fragile "From <price>" heuristic than the fiber
// walk; a miss is a soft signal, not a structural failure.
if (typeof result.fromPriceText !== "string" || !result.fromPriceText) {
  console.log("  WARN fromPriceText not found (heuristic selector may need a refresh)");
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nOK: live structure matches the fixture (prices may differ — expected).");
