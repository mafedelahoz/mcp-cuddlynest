// Per-destination JSON cache with age-based invalidation (AO-5: pre-fetched,
// periodically refreshed inventory, discarding records older than X hours).
//
// A full mirror of fc_product (~9M rows) isn't viable, so entries are keyed by
// destination and filled on demand. Entries older than CUDDLYNEST_CACHE_MAX_AGE_HOURS
// (default 6) are never served and are dropped on the next write. 

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_FILE =
  process.env.CUDDLYNEST_CACHE_FILE || join(PROJECT_ROOT, ".cache", "stays-cache.json");
const MAX_ENTRIES = 500;

export function cacheMaxAgeMs(): number {
  const hours = Number(process.env.CUDDLYNEST_CACHE_MAX_AGE_HOURS ?? 6);
  return (Number.isFinite(hours) && hours >= 0 ? hours : 6) * 3_600_000;
}

interface Entry {
  cachedAt: string; // ISO timestamp of the DB read
  value: unknown;
}

let entries: Map<string, Entry> | undefined;
let diskWarned = false;

function warnOnce(what: string, err: unknown) {
  if (diskWarned) return;
  diskWarned = true;
  const code = (err as any)?.code ?? (err instanceof Error ? err.message : String(err));
  console.error(`[${new Date().toISOString()}] [WARN] Stays cache ${what} failed (${code}); using memory only`);
}

function load(): Map<string, Entry> {
  if (entries) return entries;
  entries = new Map();
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    for (const [k, v] of Object.entries(raw?.entries ?? {})) {
      const e = v as Entry;
      if (e && typeof e.cachedAt === "string") entries.set(k, e);
    }
  } catch (err) {
    if ((err as any)?.code !== "ENOENT") warnOnce("read", err);
  }
  return entries;
}

function isFresh(e: Entry, now = Date.now()): boolean {
  return now - Date.parse(e.cachedAt) < cacheMaxAgeMs();
}

function persist(map: Map<string, Entry>) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(map) }));
    renameSync(tmp, CACHE_FILE); // atomic: readers never see a half-written file
  } catch (err) {
    warnOnce("write", err);
  }
}

/** The cached value for `key` if younger than the max age, else undefined. */
export function cacheGet<T>(key: string): { value: T; cachedAt: string } | undefined {
  const e = load().get(key);
  if (!e || !isFresh(e)) return undefined;
  return { value: e.value as T, cachedAt: e.cachedAt };
}

/** Store `value` under `key`; prunes stale entries and caps the file size. Returns cachedAt. */
export function cacheSet(key: string, value: unknown): string {
  const map = load();
  const cachedAt = new Date().toISOString();
  map.delete(key); // re-insert so Map order stays oldest -> newest
  map.set(key, { cachedAt, value });
  const now = Date.now();
  for (const [k, e] of map) if (!isFresh(e, now)) map.delete(k);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
  persist(map);
  return cachedAt;
}
