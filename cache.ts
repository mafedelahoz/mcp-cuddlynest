// Per-destination JSON cache with age-based invalidation (AO-5: pre-fetched,
// periodically refreshed inventory, discarding records older than X hours).
//
// A full mirror of fc_product (~9M rows) isn't viable, so entries are keyed by
// destination and filled on demand. Entries older than CUDDLYNEST_CACHE_MAX_AGE_HOURS
// (default 6) are never served and are dropped on the next write. The same
// JsonCache class backs the attractions (AO-10) and flights (AO-9) caches.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ENTRIES = 500;

interface Entry {
  cachedAt: string; // ISO timestamp of the source read
  value: unknown;
  meta?: unknown;
}

export interface JsonCacheOptions {
  /** Name used in warnings, e.g. "Stays". */
  label: string;
  /** Cache file path (read lazily, so env overrides set before first use apply). */
  file: () => string;
  /** Entries older than this are never served and are dropped on the next write. */
  maxAgeMs: () => number;
  maxEntries?: number;
}

/** A JSON-file cache keyed by string, with age-based invalidation and atomic writes. */
export class JsonCache {
  private entries: Map<string, Entry> | undefined;
  private diskWarned = false;

  constructor(private readonly opts: JsonCacheOptions) {}

  maxAgeMs(): number {
    return this.opts.maxAgeMs();
  }

  private warnOnce(what: string, err: unknown) {
    if (this.diskWarned) return;
    this.diskWarned = true;
    const code = (err as any)?.code ?? (err instanceof Error ? err.message : String(err));
    console.error(
      `[${new Date().toISOString()}] [WARN] ${this.opts.label} cache ${what} failed (${code}); using memory only`,
    );
  }

  private load(): Map<string, Entry> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    try {
      const raw = JSON.parse(readFileSync(this.opts.file(), "utf8"));
      for (const [k, v] of Object.entries(raw?.entries ?? {})) {
        const e = v as Entry;
        if (e && typeof e.cachedAt === "string") this.entries.set(k, e);
      }
    } catch (err) {
      if ((err as any)?.code !== "ENOENT") this.warnOnce("read", err);
    }
    return this.entries;
  }

  private isFresh(e: Entry, now = Date.now()): boolean {
    return now - Date.parse(e.cachedAt) < this.maxAgeMs();
  }

  private persist(map: Map<string, Entry>) {
    const file = this.opts.file();
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(map) }));
      renameSync(tmp, file); // atomic: readers never see a half-written file
    } catch (err) {
      this.warnOnce("write", err);
    }
  }

  /** The cached value for `key` if younger than the max age, else undefined. */
  get<T>(key: string): { value: T; cachedAt: string } | undefined {
    const e = this.load().get(key);
    if (!e || !this.isFresh(e)) return undefined;
    return { value: e.value as T, cachedAt: e.cachedAt };
  }

  /** Store `value` under `key`; prunes stale entries and caps the file size. Returns cachedAt. */
  set(key: string, value: unknown, meta?: unknown, { flush = true }: { flush?: boolean } = {}): string {
    const map = this.load();
    const cachedAt = new Date().toISOString();
    map.delete(key); // re-insert so Map order stays oldest -> newest
    map.set(key, { cachedAt, value, ...(meta !== undefined ? { meta } : {}) });
    const now = Date.now();
    for (const [k, e] of map) if (!this.isFresh(e, now)) map.delete(k);
    const max = this.opts.maxEntries ?? MAX_ENTRIES;
    while (map.size > max) map.delete(map.keys().next().value as string);
    if (flush) this.persist(map);
    return cachedAt;
  }

  delete(key: string, { flush = true }: { flush?: boolean } = {}): void {
    const map = this.load();
    if (map.delete(key) && flush) this.persist(map);
  }

  /** Write the in-memory cache to disk (after a batch of `flush: false` updates). */
  flush(): void {
    this.persist(this.load());
  }

  /** Every entry currently held (fresh or stale), oldest first, without values. */
  entriesList<M = unknown>(): { key: string; cachedAt: string; meta?: M }[] {
    return [...this.load()].map(([key, e]) => ({ key, cachedAt: e.cachedAt, meta: e.meta as M | undefined }));
  }
}

/** Hours from an env var, falling back to `fallback` when unset or invalid. */
export function envHours(name: string, fallback: number): number {
  const hours = Number(process.env[name] ?? fallback);
  return Number.isFinite(hours) && hours >= 0 ? hours : fallback;
}

export function cacheMaxAgeMs(): number {
  return envHours("CUDDLYNEST_CACHE_MAX_AGE_HOURS", 6) * 3_600_000;
}

// Stays cache (AO-5) — kept behind the original function exports.
const stays = new JsonCache({
  label: "Stays",
  file: () => process.env.CUDDLYNEST_CACHE_FILE || join(PROJECT_ROOT, ".cache", "stays-cache.json"),
  maxAgeMs: cacheMaxAgeMs,
});

export const cacheGet = <T>(key: string) => stays.get<T>(key);
export const cacheSet = (key: string, value: unknown, meta?: unknown, opts?: { flush?: boolean }) =>
  stays.set(key, value, meta, opts);
export const cacheDelete = (key: string, opts?: { flush?: boolean }) => stays.delete(key, opts);
export const cacheFlush = () => stays.flush();
export const cacheEntries = <M = unknown>() => stays.entriesList<M>();

/** Cache file next to the stays one, overridable per vertical. */
export function cacheFilePath(envVar: string, name: string): () => string {
  return () => process.env[envVar] || join(PROJECT_ROOT, ".cache", name);
}
