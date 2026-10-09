#!/usr/bin/env node
// Option B guard: the live availability API (a real-time supplier call that
// counts toward Look-to-Book) must only be reached with an explicit
// source: "live". source "auto" and "db" must never call it — not even when the
// DB is down, has no results, or the destination is ambiguous — and their
// results must never carry price/availability fields.
//
// Runs the built server against a local mock JWT issuer + availability API that
// count every hit. No real credentials are used.

import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const MOCK_JWT = `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const MOCK_KEY = "test-api-key";

const hits = { token: 0, availability: 0 };
let lastAvailability;
const mock = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (req.url === "/token" && req.method === "GET") {
    hits.token++;
    if (req.headers["x-cuddlynest-api-key"] !== MOCK_KEY) return res.writeHead(401).end();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ token: MOCK_JWT }));
    return;
  }
  if (req.url === "/api/availability" && req.method === "POST") {
    hits.availability++;
    lastAvailability = { auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ mock: true }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}`;

// A port with nothing listening -> instant ECONNREFUSED for the "DB down" case.
const closed = createServer();
await new Promise((r) => closed.listen(0, "127.0.0.1", r));
const deadPort = String(closed.address().port);
await new Promise((r) => closed.close(r));

const tmp = mkdtempSync(join(tmpdir(), "cn-live-"));
const PRICE_KEY = /price|pricing|availab|rate|cost|fee|tax|discount|currency/i;

function priceKeys(value, path = "") {
  if (Array.isArray(value)) return value.flatMap((v, i) => priceKeys(v, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(PRICE_KEY.test(k) ? [`${path}.${k}`] : []),
    ...priceKeys(v, `${path}.${k}`),
  ]);
}

async function withServer(label, env, fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    stderr: "ignore",
    env: {
      ...process.env,
      IGNORE_ROBOTS_TXT: "true",
      CUDDLYNEST_JWT_ISSUER_URL: `${base}/token`,
      CUDDLYNEST_API_KEY: MOCK_KEY,
      CUDDLYNEST_BE_AVAILABILITY_URL: `${base}/api/availability`,
      CUDDLYNEST_CACHE_FILE: join(tmp, `${label}-cache.json`),
      CUDDLYNEST_FALLBACK_LOG: join(tmp, "fallback.log"),
      ...env,
    },
  });
  const client = new Client({ name: "live-isolation", version: "0" });
  await client.connect(transport);
  try {
    return await fn(async (args) => {
      const r = await client.callTool({ name: "cuddlynest_search", arguments: args });
      return { isError: !!r.isError, json: JSON.parse(r.content[0].text) };
    });
  } finally {
    await client.close();
  }
}

let failed = 0;
const check = (ok, msg) => {
  console.log(`   ${ok ? "✅" : "❌"} ${msg}`);
  if (!ok) failed++;
};

const DATES = { checkin: "2026-11-10", checkout: "2026-11-13" };
const STATIC_CASES = [
  { destination: "Barcelona, Spain", ...DATES },
  { destination: "Atlanta, Georgia", ...DATES }, // ambiguous -> skips the DB
  { destination: "Zzxqville, Narnia", ...DATES }, // no DB results
];

try {
  for (const [label, env] of [
    ["db up", {}],
    ["db down", { CUDDLYNEST_DB_HOST: "127.0.0.1", CUDDLYNEST_DB_PORT: deadPort, CUDDLYNEST_DB_TIMEOUT_MS: "1000" }],
  ]) {
    console.log(`\n🔒 auto/db never call the live API (${label})`);
    await withServer(label.replace(" ", "-"), env, async (search) => {
      for (const source of ["auto", "db"]) {
        for (const args of STATIC_CASES) {
          const { json } = await search({ ...args, source, limit: 5 });
          const leaks = priceKeys({ stays: json.stays, hotels: json.hotels, results: json.results });
          check(leaks.length === 0, `${source} "${args.destination}" -> ${json.source}${json.dbFallbackReason ? `/${json.dbFallbackReason}` : ""}` +
            (json.code ? `/${json.code}` : "") + (leaks.length ? ` leaks ${leaks.slice(0, 3).join(", ")}` : ", no price fields"));
        }
      }
    });
    check(hits.availability === 0 && hits.token === 0,
      `live API hits: ${hits.availability}, JWT issuer hits: ${hits.token} (expected 0 / 0)`);
  }

  console.log("\n📡 source: \"live\" goes to the live API only");
  await withServer("live", { CUDDLYNEST_DB_HOST: "127.0.0.1", CUDDLYNEST_DB_PORT: deadPort }, async (search) => {
    const noDates = await search({ destination: "Paris, France", source: "live" });
    check(noDates.isError && noDates.json.liveErrorCode === "missing_dates" && hits.availability === 0,
      `no dates -> ${noDates.json.liveErrorCode}, no API call`);

    const first = await search({ destination: "Paris, France", source: "live", ...DATES });
    check(hits.availability === 1 && hits.token === 1, `called the live API once (issuer ${hits.token}, API ${hits.availability})`);
    check(lastAvailability?.auth === `Bearer ${MOCK_JWT}`, "sent Authorization: Bearer <JWT from auth.ts>");
    const b = lastAvailability?.body ?? {};
    check(b.checkin === DATES.checkin && b.checkout === DATES.checkout && b.adults === 2 && b.rooms === 1,
      "body carries dates and guests");
    check(typeof b.lat === "number" && b.aLat > b.lat && b.bLat < b.lat && b.aLng > b.lng && b.bLng < b.lng,
      "body has centre + NE (a) / SW (b) bounding box");
    check(!("hotels" in first.json) && first.json.source === "live", "no silent fallback to scraping");
    // The mock answers {"mock": true}; until the real mapping exists this must be a clear error.
    check(first.isError && first.json.liveErrorCode === "response_mapping_pending",
      `unmapped response -> clear error (${first.json.liveErrorCode})`);

    await search({ destination: "Paris, France", source: "live", ...DATES });
    check(hits.token === 1 && hits.availability === 2, "JWT reused from memory on the next call");
  });

  // TODO(AO-11): once mapAvailabilityResponse() is implemented from a real
  // response, assert here that live stays carry a `pricing` object and that their
  // static fields have no price keys.
  console.log("\n⏸  live `pricing` contents: pending real-response mapping (AO-11)");
} finally {
  mock.close();
}

console.log("\n" + "=".repeat(50));
console.log(failed ? `❌ ${failed} live-isolation check(s) failed.` : "🎉 Live-isolation checks passed.");
process.exit(failed ? 1 : 0);
