// [SIMULATED FIXTURE] Offline tests for mapAvailabilityResponse().
//
// ⚠️  These run against fixtures/SIMULATED-wide-availability-response.json, a
// HAND-WRITTEN fixture — NOT a response captured from the real availability API.
// Its field names are assumptions based on the rendered results page. Passing
// here proves the mapper's logic (aliases, parsing, price separation, defensive
// reporting), not that it matches the real API. That check is still pending:
// see docs/be-api-notes.md.
//
// Run: npm test  (pretest builds dist/)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { mapAvailabilityResponse, parseReviewText, summarizeReport } from "./dist/be-api-provider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIMULATED = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "SIMULATED-wide-availability-response.json"), "utf8"),
);
const CTX = { checkin: "2026-11-10", checkout: "2026-11-13", currency: "USD", city: "Paris", country: "France" };

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
};
const PRICE_KEY = /price|pricing|availab|rate$|cost|fee|tax|discount|currency|cancel/i;
const priceKeys = (v, p = "") =>
  Array.isArray(v) ? v.flatMap((x, i) => priceKeys(x, `${p}[${i}]`))
  : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [...(PRICE_KEY.test(k) ? [`${p}.${k}`] : []), ...priceKeys(x, `${p}.${k}`)])
  : [];

console.log("\n=== [SIMULATED FIXTURE] mapAvailabilityResponse — not a real API response ===");
const { stays, report } = mapAvailabilityResponse(SIMULATED, CTX);
const byId = Object.fromEntries(stays.map((s) => [s.id, s]));

check("[SIMULATED] finds listings at data.listings", report.listingsPath === "data.listings");
check("[SIMULATED] maps 4 of 5 listings, drops the one without an id",
  report.listingCount === 5 && report.mapped === 4 && report.dropped === 1);

const a = byId["9000001"];
check("[SIMULATED] camelCase listing: static fields",
  a?.type === "stay" && a.name === "Simulated Hotel Rivoli" && a.slug === "simulated-hotel-rivoli" &&
  a.category === "Hotel" && a.rating === 8.6 && a.location.city === "Paris" && a.location.country === "France" &&
  a.cover_image_url?.endsWith("cover-1.jpg") &&
  a.url === "https://www.cuddlynest.com/hotel/fr/simulated-hotel-rivoli-9000001");
check("[SIMULATED] camelCase listing: tags from type / stars / review label",
  ["hotel", "4-star", "superb"].every((t) => a?.tags.includes(t)));
check("[SIMULATED] camelCase listing: details (area, distance, review count)",
  a?.details.neighborhood === "1st arr." && a.details.distanceFromCenterKm === 1.2 && a.details.reviewCount === 763);
check("[SIMULATED] camelCase listing: pricing sub-object",
  a?.pricing.price === 210.5 && a.pricing.originalPrice === 260 && a.pricing.taxesAndFees === 31.2 &&
  a.pricing.freeCancellation === true && a.pricing.currency === "USD" &&
  a.pricing.checkin === CTX.checkin && a.pricing.checkout === CTX.checkout);

const b = byId["9000002"];
check("[SIMULATED] combined review text \"7.9 Very Good (1,204)\" is split",
  b?.rating === 7.9 && b.details.reviewCount === 1204 && b.tags.includes("very-good"));
check("[SIMULATED] string prices / distance parsed, image taken from images[0]",
  b?.pricing.price === 1180 && b.pricing.originalPrice === 1400 && b.pricing.taxesAndFees === 95.4 &&
  b.pricing.freeCancellation === false && b.details.distanceFromCenterKm === 4.5 &&
  b.cover_image_url?.endsWith("cover-2.jpg"));

const c = byId["9000003"];
check("[SIMULATED] snake_case aliases map the same way",
  c?.name === "Simulated Apartments Marais" && c.category === "Apartment" && c.rating === 9.1 &&
  c.details.neighborhood === "Le Marais" && c.pricing.price === 145 && c.pricing.freeCancellation === true);

const d = byId["9000004"];
check("[SIMULATED] sparse listing maps with nulls instead of throwing",
  d?.name === "Simulated Hostel With Sparse Data" && d.pricing.price === null && d.rating === null &&
  d.url === "https://www.cuddlynest.com/hotel/-9000004");

check("[SIMULATED] static fields never carry price/availability (pricing kept apart)",
  stays.every((s) => {
    const { pricing, ...rest } = s;
    return priceKeys(rest).length === 0;
  }));
check("[SIMULATED] report counts missing expected fields (sparse listing)",
  report.missingExpected.price === 1 && report.missingExpected.reviewScore === 1);
check("[SIMULATED] report lists unmapped response keys by name",
  report.unusedKeys.includes("partnerCode"));
const summary = summarizeReport(report);
check("[SIMULATED] report summary names fields but carries no values",
  summary.includes("price(1)") && !summary.includes("Simulated") && !summary.includes("210.5"));

console.log("\n=== mapAvailabilityResponse — defensive on unexpected shapes ===");
for (const [label, input] of [
  ["null", null], ["string", "oops"], ["empty object", {}], ["unknown container", { payload: { items: 3 } }],
  ["array of junk", [1, "x", null]],
]) {
  let r;
  try {
    r = mapAvailabilityResponse(input, CTX);
  } catch (e) {
    r = { error: e };
  }
  check(`${label}: no throw, 0 stays`, !r.error && r.stays.length === 0);
}
check("unknown container: report says listings not found",
  mapAvailabilityResponse({ payload: {} }, CTX).report.listingsPath === null);

console.log("\n=== parseReviewText ===");
const p = parseReviewText("8.6 Superb (763)");
check("\"8.6 Superb (763)\" -> 8.6 / Superb / 763", p?.score === 8.6 && p.label === "Superb" && p.count === 763);

console.log(failures ? `\n❌ ${failures} [SIMULATED FIXTURE] mapping check(s) failed` : "\n[SIMULATED FIXTURE] mapping: all cases passed");
process.exit(failures ? 1 : 0);
