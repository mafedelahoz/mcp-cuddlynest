// One-off: call the live availability API once and save the raw response, so the
// response -> Stay mapping (be-api-provider.ts, mapAvailabilityResponse) can be
// written from real field names. Prints timing and the response STRUCTURE only
// (keys and types, never values). The raw file goes to docs/private/ (gitignored):
// review it for anything sensitive before sharing or moving it.
//
// This is a live supplier call (counts toward L2B): run it by hand, sparingly.
// Usage: npm run build && node scripts/capture-availability.mjs ["Paris, France"] [checkin] [checkout]
import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "private", "wide-availability-sample-response.json");
mkdirSync(dirname(out), { recursive: true });
process.env.CUDDLYNEST_BE_CAPTURE_FILE = out;

const { beApiSearchProvider, mapAvailabilityResponse, summarizeReport } = await import(
  join(root, "dist", "be-api-provider.js")
);

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const [destination = "Paris, France", checkin = day(14), checkout = day(17)] = process.argv.slice(2);

function shape(v, depth = 0, indent = "  ") {
  if (Array.isArray(v)) return v.length ? `array(${v.length}) of ${shape(v[0], depth, indent)}` : "array(0)";
  if (v === null) return "null";
  if (typeof v !== "object") return typeof v;
  if (depth >= 4) return "object{…}";
  const pad = indent.repeat(depth + 1);
  return "{\n" + Object.entries(v).map(([k, x]) => `${pad}${k}: ${shape(x, depth + 1, indent)}`).join("\n") +
    "\n" + indent.repeat(depth) + "}";
}

const t0 = Date.now();
try {
  await beApiSearchProvider.searchStays({
    destination, checkin, checkout, adults: 2, children: 0, childAges: [], infants: 0, rooms: 1, currency: "USD",
  });
  console.log(`OK in ${Date.now() - t0}ms (mapping already implemented)`);
} catch (e) {
  console.log(`${e.code ?? e.name} after ${Date.now() - t0}ms: ${e.code === "response_mapping_pending" ? "API answered" : e.message}`);
}
try {
  const { readFileSync } = await import("node:fs");
  const json = JSON.parse(readFileSync(out, "utf8"));
  console.log(`\nRaw response saved to ${out}\nStructure:\n${shape(json)}`);
  // How the (assumed-name) mapping fares against the real response: field names
  // and counts only. Fix the FIELDS / LISTINGS_PATHS tables in be-api-provider.ts
  // until this shows no missing expected fields, then set MAPPING_VERIFIED = true.
  const { report } = mapAvailabilityResponse(json, { checkin, checkout, currency: "USD" });
  console.log(`\nMapping report: ${summarizeReport(report)}`);
} catch {
  console.log("\nNo response saved (the call didn't get a JSON answer).");
}
