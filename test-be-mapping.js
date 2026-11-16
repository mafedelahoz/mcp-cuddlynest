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
import { buildActivitiesQuery, mapActivitiesResponse } from "./dist/attractions-provider.js";
import { buildPassengers, mapFlightResults, normalizeCabin } from "./dist/flights-provider.js";

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

console.log("\n=== [CAPTURED STAGING] mapAvailabilityResponse — real WebSocket availability event ===");
{
  const REAL = JSON.parse(readFileSync(join(__dirname, "fixtures", "staging-ws-availability-sample.json"), "utf8"));
  const { stays: real, report: rr } = mapAvailabilityResponse(REAL, { ...CTX, currency: null, city: "Singapore", country: "Singapore" });
  check("[REAL] all listings mapped, no expected field missing",
    rr.listingsPath === "data" && rr.mapped === REAL.data.length && Object.keys(rr.missingExpected).length === 0);
  const src = REAL.data[0];
  const s0 = real[0];
  check("[REAL] name / category / id from hotel_name / main_property_type / product_id",
    s0.name === src.hotel_name && s0.category === src.main_property_type && s0.id === String(src.product_id));
  check("[REAL] GeoJSON [lng, lat] read in the right order",
    s0.location.lat === src.location.coordinates[1] && s0.location.lng === src.location.coordinates[0]);
  check("[REAL] pricing from discounted_price / lowest_price / fees / discount",
    s0.pricing.price === src.discounted_price && s0.pricing.originalPrice === src.lowest_price &&
    s0.pricing.taxesAndFees === src.fees && s0.pricing.discount === src.discount && s0.pricing.currency === null);
  check("[REAL] nearby places by category, airport also fills nearest_airport",
    Object.keys(s0.details.nearby).length > 0 &&
    (src.tags?.airport?.length ? s0.location.nearest_airport?.name === src.tags.airport[0].name : true));
  check("[REAL] no rating or review tag when a listing has 0 reviews",
    real.every((s, i) => REAL.data[i].grs_total_reviews > 0 || (s.rating === null && !s.tags.includes(String(REAL.data[i].grs_adjective_new).toLowerCase()))));
  check("[REAL] static fields carry no price/availability",
    real.every((s) => { const { pricing, ...rest } = s; return priceKeys(rest).length === 0; }));
}

console.log("\n=== [CAPTURED STAGING] mapActivitiesResponse — real attractions search ===");
{
  const ACT = JSON.parse(readFileSync(join(__dirname, "fixtures", "staging-attractions-search-sample.json"), "utf8"));
  const { attractions: list, totalCount, dropped } = mapActivitiesResponse(ACT, { city: "Bangkok", country: "Thailand" });
  check("[REAL] every activity mapped, none dropped", list.length === ACT.activities.length && dropped === 0 && totalCount === ACT.total_count);
  const src = ACT.activities.find((a) => a.ratings?.total > 0 && a.duration);
  const m = list.find((a) => a.id === src.id);
  check("[REAL] name / category / coords / image from title / category / geoCode / images[0].large",
    m.name === src.title && m.category === src.category && m.location.lat === src.geoCode.lat &&
    m.location.lng === src.geoCode.lng && m.cover_image_url === src.images[0].large);
  check("[REAL] rating (0-5) and review count from ratings", m.rating === Number(src.ratings.average) && m.details.reviewCount === src.ratings.total);
  check("[REAL] duration minutes / label / ISO", m.duration.minutes === src.duration && m.duration.label === src.duration_hours && m.duration.iso === src.iso_duration);
  check("[REAL] pricing from price / currency / available, dated by search_date",
    m.pricing.price === src.price.price && m.pricing.currency === src.price.currency &&
    m.pricing.available === src.price.available && m.pricing.date === ACT.search_date);
  check("[REAL] price.originalPrice (looks like the net rate) is never exposed",
    list.every((a) => !("originalPrice" in a.pricing)) && !JSON.stringify(list).includes(String(src.price.originalPrice)));
  check("[REAL] city / country fall back to the request when the API sends null",
    list.every((a) => a.location.city === "Bangkok" && a.location.country === "Thailand"));
  check("[REAL] no rating when an activity has 0 reviews",
    list.every((a, i) => ACT.activities[i].ratings?.total > 0 || a.rating === null));
  check("[REAL] tags slugified, description has no leading bullet",
    list.every((a) => a.tags.every((t) => /^[a-z0-9-]+$/.test(t)) && !/^[*•]/.test(a.description_short ?? "")));
  check("[REAL] static fields carry no price/availability",
    list.every((a) => { const { pricing, ...rest } = a; return priceKeys(rest).length === 0; }));
  for (const [label, input] of [["null", null], ["no activities", { total_count: 3 }], ["junk items", { activities: [null, 1, { title: "no id" }] }]]) {
    const r = mapActivitiesResponse(input, { city: null, country: null });
    check(`attractions ${label}: no throw, 0 mapped`, r.attractions.length === 0);
  }
  const q = buildActivitiesQuery("Austin, TX", 80);
  check("query: state goes into user_location, limit capped at 50",
    q.get("search_parameter") === "Austin" && q.get("user_location") === "Austin, Texas" && q.get("results_per_page") === "50");
}

console.log("\n=== [CAPTURED STAGING] mapFlightResults — real flight search results ===");
{
  const FL = JSON.parse(readFileSync(join(__dirname, "fixtures", "staging-flight-results-sample.json"), "utf8"));
  const { flights, totalCount, dropped } = mapFlightResults(FL);
  check("[REAL] every itinerary mapped", flights.length === FL.FlightSearchRS.Itineraries.length && dropped === 0 &&
    totalCount === FL.FlightSearchRS.TotalItineraries);
  const src = FL.FlightSearchRS.Itineraries[0];
  const f = flights[0];
  check("[REAL] id, legs, origin / destination airports and local times",
    f.id === src.ItineraryID && f.legs.length === src.Legs.length && f.legs[0].origin.airportCode === "BOG" &&
    f.legs[0].destination.airportCode === "MIA" && f.legs[0].origin.time === src.Legs[0].Origin.DateTime);
  const seg = src.Legs[0].Segments[0];
  check("[REAL] segment carrier and flight number",
    f.legs[0].segments[0].carrier.code === seg.MarketingCarrier.Code &&
    f.legs[0].segments[0].flightNumber === `${seg.MarketingCarrier.Code}${seg.MarketingCarrier.FlightNumber}`);
  check("[REAL] customer total / base / taxes from TotalPrice.amount",
    f.pricing.total.amount === src.ItineraryFares.TotalPrice.TotalAmount.amount &&
    f.pricing.base.amount === src.ItineraryFares.TotalPrice.BaseAmount.amount &&
    f.pricing.taxes.amount === src.ItineraryFares.TotalPrice.TotalTax.amount && f.pricing.total.currency === "USD");
  check("[REAL] supplier rate (api_amount sentinel) never exposed",
    !JSON.stringify(flights).includes("999999.99") && !JSON.stringify(flights).includes("api_amount"));
  check("[REAL] stops counted from segments", flights.every((x, i) => x.stops === Math.max(...FL.FlightSearchRS.Itineraries[i].Legs.map((l) => l.Segments.length - 1))));
  check("[REAL] baggage and conditions read", f.baggage.checked !== undefined && typeof f.conditions.changeable === "boolean");
  check("[REAL] static fields carry no price/availability",
    flights.every((x) => { const { pricing, ...rest } = x; return priceKeys(rest).length === 0; }));
  for (const [label, input] of [["null", null], ["no results", { FlightSearchRS: {} }], ["junk", { FlightSearchRS: { Itineraries: [null, { ItineraryID: "x" }] } }]]) {
    check(`flights ${label}: no throw, 0 mapped`, mapFlightResults(input).flights.length === 0);
  }
  check("passengers: adults + one entry per child age + infants",
    JSON.stringify(buildPassengers({ adults: 1, childAges: [4, 9], infants: 1 })) ===
    JSON.stringify([{ Type: "adult", Quantity: 1 }, { Type: "child", Quantity: 1, Age: 4 }, { Type: "child", Quantity: 1, Age: 9 }, { Type: "infant", Quantity: 1 }]));
  check("cabin: normalized, unknown -> economy", normalizeCabin("Premium Economy") === "premium_economy" && normalizeCabin("sofa") === "economy");
}

console.log("\n=== parseReviewText ===");
const p = parseReviewText("8.6 Superb (763)");
check("\"8.6 Superb (763)\" -> 8.6 / Superb / 763", p?.score === 8.6 && p.label === "Superb" && p.count === 763);

console.log(failures ? `\n❌ ${failures} [SIMULATED FIXTURE] mapping check(s) failed` : "\n[SIMULATED FIXTURE] mapping: all cases passed");
process.exit(failures ? 1 : 0);
