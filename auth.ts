// JWT for CuddlyNest's BE APIs (AO-15).
//
// GET CUDDLYNEST_JWT_ISSUER_URL with header `x-cuddlynest-api-key: <CUDDLYNEST_API_KEY>`
// returns a JWT. It's cached in memory and renewed ~60s before its `exp`.
//
// The issuer's response format isn't documented, so the token is found by its
// shape (three base64url segments) rather than by a field name: either the raw
// body, or the first JWT-looking string in a JSON body (searched two levels deep).
//
// Never log or return the API key or the token: errors carry only an AuthError
// code and an HTTP status.

import { config as loadEnv } from "dotenv";
import fetch from "node-fetch";

// quiet: dotenv otherwise prints to stdout, which corrupts the stdio MCP transport.
loadEnv({ quiet: true });

const RENEW_BEFORE_EXP_MS = 60_000;
// When the JWT carries no readable `exp`, keep it this long.
const DEFAULT_TTL_MS = 5 * 60_000;
const ISSUER_TIMEOUT_MS = 10_000;

export type AuthErrorCode = "not_configured" | "unauthorized" | "unavailable" | "invalid_response";

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function isAuthConfigured(): boolean {
  return !!(process.env.CUDDLYNEST_JWT_ISSUER_URL && process.env.CUDDLYNEST_API_KEY);
}

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function findJwt(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") {
    const s = value.trim().replace(/^Bearer\s+/i, "");
    return JWT_RE.test(s) ? s : undefined;
  }
  if (depth >= 2 || value == null || typeof value !== "object") return undefined;
  for (const v of Object.values(value as Record<string, unknown>)) {
    const found = findJwt(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** `exp` (ms since epoch) from the JWT payload, if present. Signature is not verified. */
function jwtExpiryMs(jwt: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

let cached: { token: string; renewAt: number } | undefined;
let inFlight: Promise<string> | undefined;

async function fetchToken(): Promise<string> {
  const url = process.env.CUDDLYNEST_JWT_ISSUER_URL;
  const key = process.env.CUDDLYNEST_API_KEY;
  if (!url || !key) {
    throw new AuthError("not_configured", "CUDDLYNEST_JWT_ISSUER_URL / CUDDLYNEST_API_KEY are not set");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ISSUER_TIMEOUT_MS);
  let status: number;
  let body: string;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-cuddlynest-api-key": key, Accept: "application/json, text/plain" },
      signal: controller.signal,
    });
    status = res.status;
    body = await res.text();
  } catch (err) {
    const code = (err as any)?.name === "AbortError" ? "timeout" : ((err as any)?.code ?? "network");
    throw new AuthError("unavailable", `JWT issuer unreachable (${code})`);
  } finally {
    clearTimeout(timer);
  }

  if (status === 401 || status === 403) {
    throw new AuthError("unauthorized", `JWT issuer rejected the API key (HTTP ${status})`);
  }
  if (status < 200 || status >= 300) {
    throw new AuthError("unavailable", `JWT issuer returned HTTP ${status}`);
  }

  let token = findJwt(body);
  if (!token) {
    try {
      token = findJwt(JSON.parse(body));
    } catch {
      /* not JSON */
    }
  }
  if (!token) throw new AuthError("invalid_response", "JWT issuer response contained no JWT");

  const exp = jwtExpiryMs(token);
  const renewAt = exp != null ? exp - RENEW_BEFORE_EXP_MS : Date.now() + DEFAULT_TTL_MS;
  cached = { token, renewAt };
  return token;
}

/**
 * A valid JWT for the BE APIs. Served from memory until ~60s before it expires;
 * concurrent callers share a single issuer request. Throws AuthError.
 */
export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.renewAt) return cached.token;
  inFlight ??= fetchToken().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

/** Drop the cached token (e.g. after the API answers 401 with it). */
export function invalidateAccessToken(): void {
  cached = undefined;
}
