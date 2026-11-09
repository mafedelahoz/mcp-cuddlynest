# BE availability API: what we know

Context: Jira AO-5, tickets AO-11 (live availability), AO-15 (auth) and AO-16
(live prices + booking). Code: `be-api-provider.ts`, `auth.ts`.
**Status: working end to end against staging (2026-11-09).**

## Usage rule (Option B, agreed with the team)

This is a live availability call and counts toward the Look-to-Book ratio. It runs
**only** when a caller passes `source: "live"` to `cuddlynest_search`.
`source: "auto"` and `source: "db"` never call it, even when the DB fails
(enforced by `test-live-isolation.js`). A failed `live` call returns an error with
`liveErrorCode`; it never falls back to scraping.

## Auth

- **JWT issuer:** `GET` on `CUDDLYNEST_JWT_ISSUER_URL` with header
  `x-cuddlynest-api-key: <CUDDLYNEST_API_KEY>`. Response: `200`,
  `application/json`, `{ "token": "<JWT>" }`. RS256, claims `iss`, `sub`, `iat`,
  `exp`, 60-minute lifetime; `auth.ts` caches it and renews ~60 s before `exp`.
  A bad key gets `403 {"error":"Invalid API Key","message":"Forbidden"}`.
- **Where the key lives:** today only in env vars (local `.env`, gitignored, or
  the process environment). For staging it is also stored in SSM as
  `/infra/staging/jwt-issuer/valid-api-keys` (SecureString, `eu-central-1`),
  mapped to client `"web"`. Reading it from SSM at deploy time is a future
  improvement; it needs IAM read access for the deploy.

## Availability: confirmed contract (staging)

- **Endpoint:** WebSocket `wss://staging-smw-4-0.cuddlynest.com/get-availability`.
  The `http://` / `ws://` URL answers `301` to `https`, and a WebSocket can't follow
  a redirect, so it must be `wss://`.
- **Handshake:** needs `Origin: https://www.cuddlynest.com` (refused without it).
  We also send `Authorization: Bearer <JWT>`. ⚠️ On staging the socket returns
  results **without any token**; production should require it (to confirm).
- **Search message** (one JSON message after the socket opens):

```json
{
  "city": "Singapore", "state": "Singapore", "country": "Singapore",
  "viewport_bounds": {
    "northeast": { "lat": 1.3397, "lng": 103.8769 },
    "southwest": { "lat": 1.2679, "lng": 103.8244 }
  },
  "autosuggestion_id": "LO258",
  "page": 1,
  "checkin": "2026-11-14", "checkout": "2026-11-15",
  "room_count": 1, "adult_count": 2, "child_count": 0,
  "sort": ["Recommended"]
}
```

  `autosuggestion_id` is the autosuggest API's `_id` (e.g. `LO258` = Singapore,
  City). City/state/country and the centre also come from autosuggest.
- **Server events, in order:** `connection` (`conn_id`), `availability`
  (`data`: array of listings, `is_cached`), then `info` (counts), `filter`
  (facet values) and `sort` (options), which can repeat. The socket stays open;
  we close it after `availability`.
- **Listing fields** (`availability.data[]`): `product_id`, `hotel_name`,
  `main_property_type`, `star_rating`, `grs_new`, `grs_adjective_new`,
  `grs_total_reviews`, `neighborhood` (optional), `distance` + `distance_unit`,
  `location` (GeoJSON point, `coordinates: [lng, lat]`), `product_images[]`,
  `lowest_price`, `discounted_price`, `discount`, `fees`, `is_free_cancellation`
  (optional), `is_breakfast_included`, `tags` (nearby places by category:
  `airport`, `food`, `landmark`, `parks`, `shopping`, `station`, each
  `{name, distance, walking_distance}`), `property_key`, `source_product_id`.
- **Timing:** first results ~120 ms after the socket opens; a full
  `cuddlynest_search` with `source: "live"` took 825 ms (Singapore, 2026-11-09).

## Mapping (`mapAvailabilityResponse`)

Verified against the real response (20/20 listings, no expected field missing;
`MAPPING_VERIFIED = true`). Each stay is the shared Stays shape plus:

- `details`: `neighborhood`, `distanceFromCenterKm`, `reviewCount`, `nearby`
- `pricing`: `price` (discounted), `originalPrice` (`lowest_price`), `discount`,
  `taxesAndFees` (`fees`), `freeCancellation`, `breakfastIncluded`, `currency`,
  `checkin`, `checkout`

`location.nearest_airport` comes from `tags.airport`. With 0 reviews, `rating`
and the review-label tag are left out (the API still sends a label like "poor").
Fixtures: `fixtures/staging-ws-availability-sample.json` (real, trimmed) and
`fixtures/SIMULATED-wide-availability-response.json` (hand-written, alias tests).

## Open questions (for FE / backend)

1. **Currency:** neither the search message nor the response says which currency
   prices are in; `pricing.currency` is `null`. Is there a currency field?
2. **Children:** the sample only has `child_count`. Where do child ages and
   infants go?
3. **Viewport:** we send a synthetic ~9.6 × 18 km box around the centre. How does
   the FE size it, and does it change results beyond the area covered?
4. **Production:** URL of the production socket, and confirmation that it
   requires the JWT.
5. **`is_cached`:** when `true`, are prices served from the backend's cache
   (no supplier call)? That matters for L2B.
6. **Pagination:** `page` > 1 for more than 20 results.

## Superseded

The first contract we tried (`POST https://secure-smw-3-0.cuddlynest.com/api/availability`,
captured from the public site) rejected the staging JWT with `401 "Jwt issuer is
not configured"`. It is no longer used.
