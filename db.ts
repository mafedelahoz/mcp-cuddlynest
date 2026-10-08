

import { config as loadEnv } from "dotenv";
import mysql from "mysql2/promise";
import { cacheDelete, cacheEntries, cacheFlush, cacheGet, cacheMaxAgeMs, cacheSet } from "./cache.js";

loadEnv({ quiet: true });

const BASE_URL = "https://www.cuddlynest.com";
// fc_rental_photos rows at <CDN>/<product_image_dir><product_image>.
const IMAGE_CDN = "https://img.cuddlynest.com/images/listings/";

const CONNECT_TIMEOUT_MS = parseInt(process.env.CUDDLYNEST_DB_TIMEOUT_MS || "5000", 10);
const QUERY_TIMEOUT_MS = parseInt(process.env.CUDDLYNEST_DB_QUERY_TIMEOUT_MS || "3000", 10);
const CIRCUIT_OPEN_MS = 60_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DbErrorCode = "not_configured" | "unavailable" | "timeout" | "query_failed";

/** Controlled failure the caller uses to decide on the fallback. Never carries credentials. */
export class DbError extends Error {
  constructor(
    public readonly code: DbErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DbError";
  }
}

const CONNECTION_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "PROTOCOL_CONNECTION_LOST",
  "ER_ACCESS_DENIED_ERROR",
  "ER_DBACCESS_DENIED_ERROR",
  "ER_CON_COUNT_ERROR",
]);

function toDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const code = String((err as any)?.code ?? "UNKNOWN");
  if (code === "ER_QUERY_TIMEOUT" || code === "PROTOCOL_SEQUENCE_TIMEOUT") {
    return new DbError("timeout", `DB query exceeded ${QUERY_TIMEOUT_MS}ms (${code})`);
  }
  if (CONNECTION_ERRORS.has(code)) {
    return new DbError("unavailable", `DB connection failed (${code})`);
  }
  return new DbError("query_failed", `DB query failed (${code})`);
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

let pool: mysql.Pool | undefined;
let circuitOpenUntil = 0;

export function isDbConfigured(): boolean {
  const e = process.env;
  return !!(e.CUDDLYNEST_DB_HOST && e.CUDDLYNEST_DB_USER && e.CUDDLYNEST_DB_NAME);
}

function getPool(): mysql.Pool {
  if (!isDbConfigured()) {
    throw new DbError("not_configured", "CUDDLYNEST_DB_* env vars are not set");
  }
  if (Date.now() < circuitOpenUntil) {
    throw new DbError("unavailable", "DB marked unavailable after a recent connection failure");
  }
  if (!pool) {
    const e = process.env;
    pool = mysql.createPool({
      host: e.CUDDLYNEST_DB_HOST,
      port: Number(e.CUDDLYNEST_DB_PORT || 3306),
      user: e.CUDDLYNEST_DB_USER,
      password: e.CUDDLYNEST_DB_PASSWORD,
      database: e.CUDDLYNEST_DB_NAME,
      connectTimeout: CONNECT_TIMEOUT_MS,
      connectionLimit: 4,
      maxIdle: 2,
      idleTimeout: 60_000,
      enableKeepAlive: true,
      decimalNumbers: true,
      supportBigNumbers: true,
      dateStrings: true,
    });
    pool.on("connection", (conn: any) => conn.on("error", () => {}));
  }
  return pool;
}

/**
 * Run one read-only SELECT with a server-side MAX_EXECUTION_TIME on the session
 */
export async function dbQuery<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new DbError("query_failed", "Only SELECT statements are allowed");
  }
  const p = getPool();
  let conn: mysql.PoolConnection | undefined;
  try {
    conn = await p.getConnection();
  } catch (err) {
    const e = toDbError(err);
    if (e.code === "unavailable" || e.code === "timeout") circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    throw e;
  }
  try {
    await conn.query("SET SESSION MAX_EXECUTION_TIME = ?", [QUERY_TIMEOUT_MS]);
    const [rows] = await conn.query({ sql, values: params, timeout: QUERY_TIMEOUT_MS + 1000 });
    return rows as T[];
  } catch (err) {
    // A client-side timeout leaves the connection mid-query; drop it from the pool.
    if ((err as any)?.code === "PROTOCOL_SEQUENCE_TIMEOUT") {
      conn.destroy();
      conn = undefined;
    }
    throw toDbError(err);
  } finally {
    conn?.release();
  }
}

// ---------------------------------------------------------------------------
// Stays
// ---------------------------------------------------------------------------

/** Common shape shared with Attractions (cross-matched by tags and location). */
export interface Stay {
  id: string;
  type: "stay";
  name: string;
  slug: string | null;
  category: string | null;
  location: {
    city: string | null;
    country: string | null;
    lat: number | null;
    lng: number | null;
    nearest_airport: { name: string; distance_km: number | null } | null;
  };
  tags: string[];
  description_short: string | null;
  amenities: string[];
  rating: number | null; // grs_new, 0-10 scale
  cover_image_url: string | null;
  url: string;
}

export interface StaySearchParams {
  city: string;
  state?: string; // matched against m_state (full name, e.g. "Texas")
  country?: string; // matched against m_country (English name, e.g. "United States")
  limit?: number;
}

const MAX_LIMIT = 50;
const CANDIDATE_POOL = 300;

const STAYS_SQL = `
SELECT
  p.id, p.optimized_title, p.formatted_title, p.product_title, p.seourl,
  p.home_type, p.m_city, p.m_country, p.lat, p.\`long\`,
  p.star_rating, p.grs_new, p.grs_adjective_new, p.breakfast_included,
  p.business_friendly, p.brand_name, p.excerpt, p.dynamic_description, p.description,
  (SELECT CONCAT(rp.product_image_dir, rp.product_image) FROM fc_rental_photos rp
     WHERE rp.product_id = p.id AND rp.status = 'Active'
     ORDER BY rp.imgPriority, rp.id LIMIT 1) AS cover_path,
  (SELECT np.name FROM fc_product_nearby_places np
     WHERE np.product_id = p.id AND np.type = 'airport'
     ORDER BY np.distance LIMIT 1) AS airport_name,
  (SELECT np.distance FROM fc_product_nearby_places np
     WHERE np.product_id = p.id AND np.type = 'airport'
     ORDER BY np.distance LIMIT 1) AS airport_distance_m
FROM (
  SELECT id, grs_new AS rank_grs, star_rating AS rank_stars FROM fc_product
  WHERE m_city = ? __FILTERS__ AND status = 'Publish'
  LIMIT ${CANDIDATE_POOL}
) c
JOIN fc_product p ON p.id = c.id
ORDER BY c.rank_grs DESC, c.rank_stars DESC, p.id
LIMIT ?`;

export async function getStaysFromDb(params: StaySearchParams): Promise<Stay[]> {
  const city = params.city.trim();
  if (!city) return [];
  const limit = Math.min(Math.max(1, Math.floor(params.limit ?? 20)), MAX_LIMIT);
  const filters: string[] = [];
  const values: unknown[] = [city];
  const state = params.state?.trim();
  const country = params.country?.trim();
  if (state) {
    filters.push("AND m_state = ?");
    values.push(state);
  }
  if (country) {
    filters.push("AND m_country = ?");
    values.push(country);
  }
  values.push(limit);
  const rows = await dbQuery(STAYS_SQL.replace("__FILTERS__", filters.join(" ")), values);
  return rows.map(rowToStay);
}

export interface CachedStays {
  stays: Stay[];
  cachedAt: string; // when this data was read from the DB
  cache: "hit" | "miss";
}

export async function getStaysCached(
  params: StaySearchParams & { cacheKey: string },
): Promise<CachedStays> {
  const limit = Math.min(Math.max(1, Math.floor(params.limit ?? 20)), MAX_LIMIT);
  const hit = cacheGet<Stay[]>(params.cacheKey);
  if (hit) return { stays: hit.value.slice(0, limit), cachedAt: hit.cachedAt, cache: "hit" };

  const stays = await getStaysFromDb({ ...params, limit: MAX_LIMIT });
  const filter: StayFilter = { city: params.city, state: params.state, country: params.country };
  const cachedAt = stays.length
    ? cacheSet(params.cacheKey, stays, filter)
    : new Date().toISOString();
  return { stays: stays.slice(0, limit), cachedAt, cache: "miss" };
}

function rowToStay(r: any): Stay {
  const id = String(r.id);
  const lat = num(r.lat);
  const lng = num(r.long);
  const airportDistance = num(r.airport_distance_m);
  return {
    id,
    type: "stay",
    name: titleCaseIfShouting(displayTitle(r) ?? `Stay ${id}`),
    slug: firstNonEmpty(r.seourl) ?? null,
    category: firstNonEmpty(r.home_type) ?? null,
    location: {
      city: firstNonEmpty(r.m_city) ?? null,
      country: firstNonEmpty(r.m_country) ?? null,
      lat: lat || null,
      lng: lng || null,
      nearest_airport: r.airport_name
        ? {
            name: String(r.airport_name),
            // fc_product_nearby_places.distance is in metres.
            distance_km: airportDistance != null ? Math.round(airportDistance / 100) / 10 : null,
          }
        : null,
    },
    tags: buildTags(r),
    description_short: shortDescription(r.excerpt, r.dynamic_description, r.description),
    amenities: [],
    rating: num(r.grs_new) || null,
    cover_image_url: r.cover_path ? IMAGE_CDN + String(r.cover_path).replace(/^\/+/, "") : null,
    url: `${BASE_URL}/hotel/-${id}`,
  };
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstNonEmpty(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    const s = v == null ? "" : String(v).trim();
    // Some feeds store the literal string "NULL".
    if (s && s.toLowerCase() !== "null") return s;
  }
  return undefined;
}

function displayTitle(r: any): string | undefined {
  for (const v of [r.optimized_title, r.formatted_title]) {
    const s = firstNonEmpty(v);
    if (s && /\s/.test(s)) return s;
  }
  return firstNonEmpty(r.product_title, r.formatted_title, r.optimized_title);
}

// Placeholder brand values that mean "no brand".
const NO_BRAND = /^(independent|independent-other hotels|none|n\/a)$/i;

export function titleCaseIfShouting(name: string): string {
  if (!/[A-Z]/.test(name) || name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s\-(/])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

function slugTag(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildTags(r: any): string[] {
  const tags: string[] = [];
  const homeType = firstNonEmpty(r.home_type);
  if (homeType) tags.push(slugTag(homeType));
  const stars = num(r.star_rating);
  if (stars && stars > 0) tags.push(`${stars}-star`);
  const adjective = firstNonEmpty(r.grs_adjective_new);
  if (adjective) tags.push(slugTag(adjective));
  if (Number(r.breakfast_included) === 1) tags.push("breakfast-included");
  if (String(r.business_friendly) === "yes") tags.push("business-friendly");
  const brand = firstNonEmpty(r.brand_name);
  if (brand && !NO_BRAND.test(brand)) tags.push(slugTag(brand));
  return [...new Set(tags.filter(Boolean))];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  nbsp: " ",
  quot: '"',
  apos: "'",
  "#39": "'",
  lt: "<",
  gt: ">",
};

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>|<\/p>|<\/br>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#\d+|[a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
}

const BOILERPLATE = /\b(?:Property\s+Desc(?:ription)?\s*:|Property\s+Location\b|Head\s*Line\s*:|Location\s*:)\s*/gi;

export function shortDescription(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (c == null) continue;
    const text = stripHtml(String(c)).replace(BOILERPLATE, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length <= 300) return text;
    const cut = text.slice(0, 299);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 200 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:]+$/, "") + "…";
  }
  return null;
}

// Re-reads the DB for every destination already in the cache, so popular
// destinations stay warm instead of being refreshed only when someone searches
// them after they expire. 

type StayFilter = Pick<StaySearchParams, "city" | "state" | "country">;

function filterFromKey(key: string): StayFilter {
  const [city = "", state, country] = key.split("|");
  return { city, state: state || undefined, country: country || undefined };
}

export interface RefreshSummary {
  destinations: number;
  refreshed: number;
  emptied: number; 
  failed: number;
  aborted?: DbErrorCode; 
  durationMs: number;
}

export async function refreshStaysCache(): Promise<RefreshSummary> {
  const started = Date.now();
  const entries = cacheEntries<StayFilter>();
  const summary: RefreshSummary = {
    destinations: entries.length,
    refreshed: 0,
    emptied: 0,
    failed: 0,
    durationMs: 0,
  };
  try {
    for (const e of entries) {
      const filter = e.meta?.city ? e.meta : filterFromKey(e.key);
      try {
        const stays = await getStaysFromDb({ ...filter, limit: MAX_LIMIT });
        if (stays.length) {
          cacheSet(e.key, stays, filter, { flush: false });
          summary.refreshed++;
        } else {
          cacheDelete(e.key, { flush: false });
          summary.emptied++;
        }
      } catch (err) {
        summary.failed++;
        const code = err instanceof DbError ? err.code : "query_failed";
        if (code === "unavailable" || code === "not_configured") {
          summary.aborted = code;
          break;
        }
      }
    }
  } finally {
    cacheFlush();
    summary.durationMs = Date.now() - started;
  }
  return summary;
}

type Log = (level: "info" | "warn" | "error", message: string, data?: any) => void;

let refreshTimer: NodeJS.Timeout | undefined;

export function startStaysCacheRefresh(log: Log): { intervalMs: number } | undefined {
  if (refreshTimer || !isDbConfigured()) return undefined;
  const defaultHours = cacheMaxAgeMs() / 3_600_000;
  const raw = process.env.CUDDLYNEST_CACHE_REFRESH_INTERVAL_HOURS;
  const hours = raw != null && raw !== "" ? Number(raw) : defaultHours;
  if (!Number.isFinite(hours) || hours <= 0) return undefined;
  const intervalMs = Math.min(Math.round(hours * 3_600_000), 2 ** 31 - 1);

  let running = false;
  refreshTimer = setInterval(async () => {
    if (running) return; 
    running = true;
    try {
      const summary = await refreshStaysCache();
      log(summary.aborted ? "warn" : "info", "Stays cache background refresh", summary);
    } catch (e) {
      log("warn", "Stays cache background refresh failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      running = false;
    }
  }, intervalMs);
  refreshTimer.unref();
  return { intervalMs };
}
