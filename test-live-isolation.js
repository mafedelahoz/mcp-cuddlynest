#!/usr/bin/env node
// Option B guard: the live availability API (a real-time supplier call that
// counts toward Look-to-Book) must only be reached with an explicit
// source: "live". source "auto" and "db" must never call it — not even when the
// DB is down, has no results, or the destination is ambiguous — and their
// results must never carry price/availability fields.
//
// Runs the built server against a local mock JWT issuer + availability WebSocket
// that count every hit. The socket replays a real staging availability event
// (fixtures/staging-ws-availability-sample.json); the attractions mock replays a
// real staging search (fixtures/staging-attractions-search-sample.json). No real
// credentials are used.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const MOCK_JWT = `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const MOCK_KEY = "test-api-key";

const REAL_AVAILABILITY = JSON.parse(readFileSync(new URL("./fixtures/staging-ws-availability-sample.json", import.meta.url), "utf8"));
const REAL_FLIGHTS = JSON.parse(readFileSync(new URL("./fixtures/staging-flight-results-sample.json", import.meta.url), "utf8"));
const CACHED_SESSION = "11111111-1111-4111-8111-111111111111";
const REAL_ACTIVITIES = JSON.parse(readFileSync(new URL("./fixtures/staging-attractions-search-sample.json", import.meta.url), "utf8"));
const ORIGIN = "https://www.cuddlynest.com";

const hits = { token: 0, availability: 0, attractions: 0, flights: 0 };
let lastFlightSearch, lastResultsSession;
let resultsReads = 0, flaky408 = false;
let lastAttractions;
let attractionsMode = "ok"; // "ok" | "error" (answers 500)
let lastAvailability;
let socketMode = "ok"; // "ok" | "close" (closes without results)
const mock = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (req.url === "/token" && req.method === "GET") {
    hits.token++;
    if (req.headers["x-cuddlynest-api-key"] !== MOCK_KEY) return res.writeHead(401).end();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ token: MOCK_JWT }));
    return;
  }
  // Flights: autosuggest, search (answers a cached session id, like staging), results.
  if (req.url.startsWith("/api/flight/")) {
    hits.flights++;
    const u = new URL(req.url, "http://mock");
    const json = (o, code = 200) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(o));
    if (u.pathname === "/api/flight/autosuggest") {
      const city = u.searchParams.get("query");
      const code = { Bogota: "BOG", Miami: "MIA" }[city];
      return json({ status: "success", data: code ? [{ city_name: city, city_code: code, country_name: "X", country_code: "XX",
        airports: [{ airport_code: code, airport_name: `${city} Intl` }], is_nearby_match: false }] : [] });
    }
    if (u.pathname === "/api/flight/search" && req.method === "POST") {
      lastFlightSearch = JSON.parse(Buffer.concat(chunks).toString());
      return json(CACHED_SESSION);
    }
    if (u.pathname === "/api/flight/results") {
      lastResultsSession = u.searchParams.get("sessionID");
      resultsReads++;
      // Like staging: the first read of a session can 408, a second one works.
      if (flaky408 && resultsReads === 1) return json({ detail: "Search timed out waiting for results" }, 408);
      return lastResultsSession === CACHED_SESSION ? json(REAL_FLIGHTS) : json({ detail: "Search timed out waiting for results" }, 408);
    }
  }
  if (req.url.startsWith("/v2.2/activities/") && req.method === "GET") {
    hits.attractions++;
    lastAttractions = new URL(req.url, "http://mock").searchParams;
    if (attractionsMode === "error") return res.writeHead(500).end();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(REAL_ACTIVITIES));
    return;
  }
  res.writeHead(404).end();
});
// Like staging: the handshake is refused without the site's Origin header.
const wss = new WebSocketServer({
  server: mock,
  path: "/get-availability",
  verifyClient: ({ req }) => req.headers.origin === ORIGIN,
});
wss.on("connection", (ws, req) => {
  hits.availability++;
  lastAvailability = { auth: req.headers.authorization, origin: req.headers.origin, body: null };
  ws.send(JSON.stringify({ conn_id: "mock", event: "connection" }));
  ws.on("message", (raw) => {
    lastAvailability.body = JSON.parse(String(raw));
    if (socketMode === "close") return ws.close(1011, "mock failure");
    ws.send(JSON.stringify(REAL_AVAILABILITY));
    ws.send(JSON.stringify({ event: "info", data: { total_property_count: 2 } }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}`;
const wsBase = `ws://127.0.0.1:${mock.address().port}`;

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
      CUDDLYNEST_BE_AVAILABILITY_URL: `${wsBase}/get-availability`,
      CUDDLYNEST_ATTRACTIONS_API_URL: base,
      CUDDLYNEST_FLIGHTS_API_URL: base,
      CUDDLYNEST_CACHE_FILE: join(tmp, `${label}-cache.json`),
      CUDDLYNEST_ATTRACTIONS_CACHE_FILE: join(tmp, `${label}-attractions-cache.json`),
      CUDDLYNEST_FLIGHTS_CACHE_FILE: join(tmp, `${label}-flights-cache.json`),
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

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const DATES = { checkin: day(20), checkout: day(23) };
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
        const attr = await search({ destination: "Bangkok, Thailand", vertical: "attractions", source });
        check(attr.json.source === "unavailable" && attr.json.reason === "attractions_not_cached" && attr.json.results.length === 0,
          `${source} attractions -> unavailable/${attr.json.reason}`);
        const fl = await search({ destination: "Miami", origin: "Bogota", vertical: "flights", source, ...DATES });
        check(fl.json.source === "unavailable" && fl.json.reason === "flights_not_cached" && fl.json.results.length === 0,
          `${source} flights -> unavailable/${fl.json.reason}`);
      }
    });
    check(hits.availability === 0 && hits.token === 0 && hits.attractions === 0 && hits.flights === 0,
      `live API hits: ${hits.availability}, JWT issuer hits: ${hits.token}, attractions API hits: ${hits.attractions}, ` +
      `flights API hits: ${hits.flights} (expected 0 / 0 / 0 / 0)`);
  }

  console.log("\n📡 source: \"live\" goes to the live API only");
  await withServer("live", { CUDDLYNEST_DB_HOST: "127.0.0.1", CUDDLYNEST_DB_PORT: deadPort }, async (search) => {
    const noDates = await search({ destination: "Paris, France", source: "live" });
    check(noDates.isError && noDates.json.liveErrorCode === "missing_dates" && hits.availability === 0,
      `no dates -> ${noDates.json.liveErrorCode}, no API call`);

    const first = await search({ destination: "Paris, France", source: "live", ...DATES });
    check(hits.availability === 1 && hits.token === 1, `called the live API once (issuer ${hits.token}, API ${hits.availability})`);
    check(lastAvailability?.auth === `Bearer ${MOCK_JWT}`, "sent Authorization: Bearer <JWT from auth.ts>");
    check(lastAvailability?.origin === ORIGIN, "sent the Origin header the socket requires");
    const b = lastAvailability?.body ?? {};
    check(b.checkin === DATES.checkin && b.checkout === DATES.checkout && b.adult_count === 2 && b.room_count === 1 &&
      b.child_count === 0 && Array.isArray(b.sort), "search message carries dates, guests and sort");
    const vb = b.viewport_bounds ?? {};
    check(vb.northeast?.lat > vb.southwest?.lat && vb.northeast?.lng > vb.southwest?.lng && typeof b.autosuggestion_id === "string" &&
      b.city && b.country, "search message has place, autosuggestion_id and NE/SW viewport");
    check(!first.isError && first.json.source === "live" && !("hotels" in first.json), "live answer, no scraping involved");
    const stays = first.json.stays ?? [];
    check(stays.length === REAL_AVAILABILITY.data.length && stays.every((s) => typeof s.pricing?.price === "number"),
      `${stays.length} live stays, each with a pricing section`);
    check(stays.every((s) => { const { pricing, ...rest } = s; return priceKeys(rest).length === 0; }),
      "static fields of live stays carry no price/availability");

    await search({ destination: "Paris, France", source: "live", ...DATES });
    check(hits.token === 1 && hits.availability === 2, "JWT reused from memory on the next call");

    socketMode = "close";
    const broken = await search({ destination: "Paris, France", source: "live", ...DATES });
    check(broken.isError && broken.json.liveErrorCode === "unavailable" && !("hotels" in broken.json),
      `socket closes without results -> clear error (${broken.json.liveErrorCode}), no fallback`);
  });

  console.log("\n🎟️  vertical: \"attractions\" + source: \"live\" goes to the attractions API only");
  await withServer("attractions", { CUDDLYNEST_DB_HOST: "127.0.0.1", CUDDLYNEST_DB_PORT: deadPort }, async (search) => {
    const before = { ...hits };
    const r = await search({ destination: "Bangkok, Thailand", vertical: "attractions", source: "live", limit: 5 });
    check(hits.attractions === before.attractions + 1 && hits.availability === before.availability && hits.token === before.token,
      "one attractions API call, no stays live API or JWT issuer call");
    check(lastAttractions?.get("search_parameter") === "Bangkok" && lastAttractions.get("user_location") === "Bangkok, Thailand" &&
      lastAttractions.get("search_type") === "destination" && lastAttractions.get("results_per_page") === "50",
      "query: search_parameter / user_location / search_type=destination / results_per_page=50 (fills the cache)");
    const list = r.json.attractions ?? [];
    check(!r.isError && r.json.source === "live" && list.length === 5 && list.every((a) => a.type === "attraction"),
      `${list.length} attractions (limit 5 of ${REAL_ACTIVITIES.activities.length})`);
    check(list.every((a) => a.url.endsWith(`/attractions/detail/${a.id}`) && typeof a.pricing?.price === "number"),
      "each has a /attractions/detail/{id} url and a pricing section");
    check(list.every((a) => { const { pricing, ...rest } = a; return priceKeys(rest).length === 0; }),
      "static fields of attractions carry no price/availability");

    // AO-10: auto/db now answer from the cache the live search filled, with no API call.
    const callsAfterLive = hits.attractions;
    for (const source of ["auto", "db"]) {
      const c = await search({ destination: "Bangkok, Thailand", vertical: "attractions", source, limit: 3 });
      check(!c.isError && c.json.source === "cache" && c.json.attractions.length === 3 && c.json.cachedAt === r.json.cachedAt,
        `${source} after a live search -> cache hit (${c.json.attractions?.length} attractions, cachedAt kept)`);
    }
    check(hits.attractions === callsAfterLive, "cache hits made no attractions API call");

    attractionsMode = "error";
    const broken = await search({ destination: "Bangkok, Thailand", vertical: "attractions", source: "live" });
    check(broken.isError && broken.json.liveErrorCode === "http_error" && !("hotels" in broken.json) && !("stays" in broken.json),
      `attractions API 500 -> clear error (${broken.json.liveErrorCode}), no fallback`);
  });

  console.log("\n✈️  vertical: \"flights\" + source: \"live\" goes to the flights API only");
  await withServer("flights", { CUDDLYNEST_DB_HOST: "127.0.0.1", CUDDLYNEST_DB_PORT: deadPort }, async (search) => {
    const before = { ...hits };
    const noOrigin = await search({ destination: "Miami", vertical: "flights", source: "live", ...DATES });
    check(noOrigin.isError && noOrigin.json.liveErrorCode === "invalid_input" && hits.flights === before.flights,
      "no origin -> invalid_input, no API call");
    const noAges = await search({ destination: "Miami", origin: "Bogota", vertical: "flights", source: "live", children: 1, ...DATES });
    check(noAges.isError && noAges.json.liveErrorCode === "invalid_input" && hits.flights === before.flights,
      "children without childAges -> invalid_input, no API call");

    const r = await search({ destination: "Miami", origin: "Bogota", vertical: "flights", source: "live", checkin: DATES.checkin,
      adults: 2, childAges: [7], infants: 1, cabinClass: "business", limit: 2 });
    check(hits.availability === before.availability && hits.token === before.token && hits.attractions === before.attractions,
      "no stays live API, JWT issuer or attractions call");
    const rq = lastFlightSearch?.FlightSearchRQ ?? {};
    const od = rq.SearchCriteria?.OriginDestinations ?? [];
    check(od.length === 1 && od[0].Departure === "BOG" && od[0].Arrival === "MIA" && od[0].DepartureDate === DATES.checkin,
      "one way BOG -> MIA resolved through autosuggest");
    check(JSON.stringify(rq.Passengers) === JSON.stringify([{ Type: "adult", Quantity: 2 }, { Type: "child", Quantity: 1, Age: 7 }, { Type: "infant", Quantity: 1 }]) &&
      rq.Filters?.CabinClass === "business" && rq.Currency === "USD", "passengers (adults, child ages, infants), cabin and currency");
    check(lastResultsSession === CACHED_SESSION && r.json.sessionId === CACHED_SESSION, "results read with the session id the search answered");
    const list = r.json.flights ?? [];
    check(!r.isError && r.json.source === "live" && list.length === 2 && list.every((f) => f.type === "flight" && f.pricing?.total?.amount > 0),
      `${list.length} flights (limit 2), each with a customer total`);
    check(!JSON.stringify(r.json).includes("999999.99") && !JSON.stringify(r.json).includes("api_amount"),
      "supplier rate (api_amount) never exposed");
    check(list.every((f) => { const { pricing, ...rest } = f; return priceKeys(rest).length === 0; }),
      "static fields of flights carry no price/availability");

    // AO-9: the same search with auto/db hits the cache, by typed city or IATA code, with no API call.
    const flightCalls = hits.flights;
    const same = { vertical: "flights", checkin: DATES.checkin, adults: 2, childAges: [7], infants: 1, cabinClass: "business", limit: 2 };
    const byCity = await search({ ...same, destination: "Miami", origin: "Bogota", source: "auto" });
    const byCode = await search({ ...same, destination: "MIA", origin: "BOG", source: "db" });
    check(byCity.json.source === "cache" && byCity.json.flights.length === 2 && byCode.json.source === "cache" && hits.flights === flightCalls,
      `auto by city and db by IATA -> cache hits, no flights API call (${byCity.json.source} / ${byCode.json.source})`);
    check(!JSON.stringify(byCity.json).includes("999999.99"), "cached flights don't carry the supplier rate either");
    const otherPax = await search({ ...same, adults: 1, destination: "Miami", origin: "Bogota", source: "auto" });
    check(otherPax.json.reason === "flights_not_cached" && hits.flights === flightCalls, "different passengers -> cache miss, still no API call");

    await search({ destination: "Miami", origin: "BOG", vertical: "flights", source: "live", ...DATES });
    check(lastFlightSearch.FlightSearchRQ.SearchCriteria.OriginDestinations.length === 2 &&
      lastFlightSearch.FlightSearchRQ.SearchCriteria.OriginDestinations[1].Departure === "MIA", "checkout adds the return leg");
    flaky408 = true; resultsReads = 0;
    const retried = await search({ destination: "Miami", origin: "BOG", vertical: "flights", source: "live", ...DATES });
    check(!retried.isError && resultsReads === 2 && retried.json.flights.length > 0, "backend 408 -> results read once more, then answers");
    flaky408 = false;
    const unknown = await search({ destination: "Zzxq", origin: "BOG", vertical: "flights", source: "live", ...DATES });
    check(unknown.isError && unknown.json.liveErrorCode === "airport_not_found", `unknown city -> ${unknown.json.liveErrorCode}, no fallback`);
  });

  console.log("\n🗂️  attractions cache refresh / expiry (AO-10)");
  {
    process.env.CUDDLYNEST_ATTRACTIONS_API_URL = base;
    process.env.CUDDLYNEST_ATTRACTIONS_CACHE_FILE = join(tmp, "unit-attractions-cache.json");
    const a = await import("./dist/attractions-provider.js");
    attractionsMode = "ok";
    await a.searchAttractions({ destination: "Dubai, United Arab Emirates" });
    const ok = await a.refreshAttractionsCache();
    check(ok.destinations === 1 && ok.refreshed === 1 && ok.failed === 0, `refresh re-reads cached destinations (${ok.refreshed}/${ok.destinations})`);
    attractionsMode = "error";
    const bad = await a.refreshAttractionsCache();
    check(bad.failed === 1 && bad.failures[0]?.code === "http_error" && a.getCachedAttractions("Dubai, United Arab Emirates"),
      "failed refresh is reported with its code and keeps the still-fresh entry");
    attractionsMode = "ok";
    process.env.CUDDLYNEST_ATTRACTIONS_CACHE_MAX_AGE_HOURS = "0";
    check(a.getCachedAttractions("Dubai, United Arab Emirates") === undefined, "entries older than the max age are never served");
    delete process.env.CUDDLYNEST_ATTRACTIONS_CACHE_MAX_AGE_HOURS;
  }
} finally {
  wss.close();
  mock.close();
}

console.log("\n" + "=".repeat(50));
console.log(failed ? `❌ ${failed} live-isolation check(s) failed.` : "🎉 Live-isolation checks passed.");
process.exit(failed ? 1 : 0);
