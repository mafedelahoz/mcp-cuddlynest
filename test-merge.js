// Network-independent tests for the CuddlyNest room-stream plumbing:
//   - destination slug + sessionid construction match real captures
//   - outgoing search frame matches the captured page->Worker payload
//   - Connection.Message extraction, terminal detection, accumulation, dedupe
//
// Run: npm test  (pretest builds dist/)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildRoomGroupsSessionId, buildDestinationSlug } from "./dist/cuddlynest.js";
import {
  buildSearchFrame,
  extractUnitDetails,
  mergeUnitDetails,
  accumulatorToResult,
} from "./dist/rooms-ws.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
};

// --- 1. destination slug -----------------------------------------------------
console.log("\n=== destination slug ===");
check(
  'buildDestinationSlug("Santa Marta","Magdalena","Colombia") === "SantaMartaMagdalenaColombia"',
  buildDestinationSlug("Santa Marta", "Magdalena", "Colombia") === "SantaMartaMagdalenaColombia",
);
check(
  'ISO country code expanded: ("Santa Marta","Magdalena","CO") === "SantaMartaMagdalenaColombia"',
  buildDestinationSlug("Santa Marta", "Magdalena", "CO") === "SantaMartaMagdalenaColombia",
);

// --- 2. sessionid ----------------------------------------------------------
console.log("\n=== sessionid construction ===");
const payload = load("socket_payload.json");
const capturedSessionId = payload.payload.data.sessionid;
// The socket_payload fixture predates the children=1 A/B; its slug field carries 0:0.
const built = buildRoomGroupsSessionId({
  destinationSlug: "SantaMartaMagdalenaColombia",
  hotelProductId: "4395541",
  checkin: "2026-10-05",
  checkout: "2026-10-08",
  adults: 2,
  children: 0,
  infants: 0,
  rooms: 1,
  currency: "COP",
  propertyType: "Hotel",
});
check(`built === captured\n     ${built}`, built === capturedSessionId);
check(
  "children:infants order (children=1 -> ...:1:0:2:1:...)",
  buildRoomGroupsSessionId({
    destinationSlug: "SantaMartaMagdalenaColombia",
    hotelProductId: "4395541",
    checkin: "2026-10-05",
    checkout: "2026-10-08",
    adults: 2,
    children: 1,
    infants: 0,
    rooms: 1,
    currency: "COP",
  }).includes(":SantaMartaMagdalenaColombia:1:0:2:1:Hotel:"),
);

// --- 3. outgoing search frame -------------------------------------------
console.log("\n=== outgoing search frame ===");
const frame = buildSearchFrame({
  sessionid: "room_groups_:SantaMartaMagdalenaColombia:1:0:2:1:Hotel:viewport:COP:4395541:2026-10-05:2026-10-08:cop",
  productId: "4395541",
  checkin: "2026-10-05",
  checkout: "2026-10-08",
  currency: "COP",
  adults: 2,
  children: 1,
  infants: 0,
  rooms: 1,
  childAges: [2],
  location: "Santa Marta, Magdalena, Colombia",
  locationType: "Hotel",
});
const expected = {
  checkin: "2026-10-05",
  checkout: "2026-10-08",
  currency: "COP",
  rooms: 1,
  adults: 2,
  children: 1,
  infants: 0,
  childrenAges: "2",
  product_id: "4395541",
  child_ages: [2],
  numberOfChildrenBelow17: 1,
  numberOfChildrenBelow2: 0,
  listing_id: "4395541",
  type: "viewport",
  user_country: "",
  location: "Santa Marta, Magdalena, Colombia",
  location_type: "Hotel",
  price: null,
};
for (const [k, v] of Object.entries(expected)) {
  check(`frame.${k} = ${JSON.stringify(v)}`, JSON.stringify(frame[k]) === JSON.stringify(v));
}

// --- 4. extraction + terminal detection -------------------------------
console.log("\n=== Connection.Message extraction ===");
const got = extractUnitDetails(payload, capturedSessionId);
check("matched", got.matched === true);
check("status partial, not terminal", got.status === "partial" && got.terminal === false);
check("unit_details is a 9-element array", Array.isArray(got.unitDetails) && got.unitDetails.length === 9);
check(
  "terminal on status:success",
  extractUnitDetails(
    { type: "Connection.Message", payload: { status: "success", data: { sessionid: capturedSessionId, unit_details: [] } } },
    capturedSessionId,
  ).terminal === true,
);
check(
  "terminal on data.streaming_status:complete",
  extractUnitDetails(
    { type: "Connection.Message", payload: { status: "partial", data: { sessionid: capturedSessionId, unit_details: [], streaming_status: "complete" } } },
    capturedSessionId,
  ).terminal === true,
);
check("rejects a mismatched sessionid", extractUnitDetails(payload, "room_groups_:Other:0:0:2:1:Hotel:viewport:USD:1:2026-01-01:2026-01-02:usd").matched === false);
check("ignores non Connection.Message", extractUnitDetails({ type: "Something.Else" }, capturedSessionId).matched === false);

// --- 5. accumulation across partial messages --------------------------
console.log("\n=== accumulation across partial messages ===");
const units = payload.payload.data.unit_details;
const mkFrame = (slice) => ({
  type: "Connection.Message",
  payload: { status: "partial", data: { sessionid: capturedSessionId, unit_details: slice, filters: payload.payload.data.filters } },
});
const acc = new Map();
for (const f of [mkFrame(units.slice(0, 4)), mkFrame(units.slice(4))]) {
  mergeUnitDetails(acc, extractUnitDetails(f, capturedSessionId).unitDetails);
}
check("9 distinct units from 2 partial frames", acc.size === 9);

const reprice = JSON.parse(JSON.stringify(units.slice(0, 2)));
reprice[0].unit_price = 999;
mergeUnitDetails(acc, reprice);
check("re-priced duplicate frame does not add rows", acc.size === 9);

const result = accumulatorToResult(capturedSessionId, acc, {
  filters: payload.payload.data.filters,
  messageCount: 3,
  status: "complete",
});
check(
  "result sorted ascending by unit_price",
  result.unitDetails.every((u, i, a) => i === 0 || Number(a[i - 1].unit_price) <= Number(u.unit_price)),
);
check(
  "partnersSeen includes the known wholesale suppliers",
  ["dida travels", "hotelplanner", "ratehawk"].every((p) => result.partnersSeen.includes(p)),
);
check("filters passed through", JSON.stringify(result.filters) === JSON.stringify(payload.payload.data.filters));

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall cases passed");
process.exit(failures ? 1 : 0);
