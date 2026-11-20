<img src="assets/icon.png" alt="CuddlyNest" width="88" align="right">

# CuddlyNest Search & Listings — MCP Server

[![npm](https://img.shields.io/npm/v/cuddlynest-mcp)](https://www.npmjs.com/package/cuddlynest-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.mafedelahoz%2Fcuddlynest--mcp-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=cuddlynest)

A Model Context Protocol (MCP) server for searching [CuddlyNest](https://www.cuddlynest.com)
hotels and retrieving listing details, including **room options, prices,
availability and cancellation policies**.

Read-only by default: search and listing details only. No booking, no payment.
Booking steps exist behind `CUDDLYNEST_ENABLE_BOOKING_TOOLS=true` (off by default);
they never take card data, payment happens on CuddlyNest's checkout.


## How it gets the data

This server reads that data **the same way a visitor does**: it opens the real,
public listing page in a headless browser (Playwright/Chromium), lets *the
page's own JavaScript* load the rooms, waits for them to render, and reads the
result out of the DOM.


| Data | Source |
| --- | --- |
| Name, description, address, coordinates, star rating, amenities, images | Listing page `schema.org` `ld+json` + Open Graph tags (`cuddlynest.ts`) |
| Room title, partner, `unit_price`, `remaining_rooms`, `price_breakdown`, `cancellation_policy` (incl. `.text`), `room_filters` | Rendered listing page DOM, via a React-fiber walk (`scrape-listing.ts`) |
| Destination → place candidates + top hotels | `autosuggestion-2-0.cuddlynest.com` (public, no auth) |
| Destination → broader city hotel list (~60–250) | `discovery-pages.cuddlynest.com/fetch_geopage/<ct-id>` (public); `<ct-id>` recovered from a hotel's product-detail breadcrumbs |
| `product_id` → name / city / breadcrumbs | `ldp-2-0-product-details.cuddlynest.com/api/v1/productDetail` (public) |
| `product_id` → canonical listing path | `/hotel/-<id>` server redirect |

### The DOM extraction, and how it breaks

`extractRoomsFromDom()` walks every price-shaped text node (`COL$742,637`), then
walks up its **React fiber tree** to the nearest ancestor component whose props
carry both `unit_price` and `roomGroups`. Those props are the room offer the
page already rendered.

This is coupled to CuddlyNest's current frontend internals (a React prop shape,
not a stable contract). If they ship a frontend change it can start returning
zero rooms even though the public page still shows prices. The single place to
update is the detector condition `'unit_price' in p && 'roomGroups' in p` in
[scrape-listing.ts](scrape-listing.ts). `npm run e2e:sansiraka` is meant to
catch that early (non-zero exit, not a silent empty result).

The `fromPriceText` ("From COL$…") field uses a looser heuristic and can come
back `null` even on a healthy scrape; `rooms.fromPrice` (cheapest extracted
unit) is the reliable figure.

---

## Requirements

- Node.js 18+
- A Chromium build for Playwright. `npm install` runs `playwright install
  chromium` automatically (postinstall); if that is blocked in your
  environment, run `npx playwright install chromium` once by hand.

## Installation

Published as [`cuddlynest-mcp`](https://www.npmjs.com/package/cuddlynest-mcp) on
npm and listed in the [official MCP registry](https://registry.modelcontextprotocol.io/v0/servers?search=cuddlynest)
as `io.github.mafedelahoz/cuddlynest-mcp`.

```json
{
  "mcpServers": {
    "cuddlynest": {
      "command": "npx",
      "args": ["-y", "cuddlynest-mcp"]
    }
  }
}
```

Add `"--ignore-robots-txt"` to `args` to bypass `robots.txt` for the
listing-page fetches. `CUDDLYNEST_SCRAPE_TIMEOUT_MS` (default `35000`) caps how
long the browser waits for prices to render.

An MCPB bundle (`.mcpb`) for Claude Desktop is attached to each
[GitHub release](https://github.com/mafedelahoz/mcp-cuddlynest/releases) — note it
does **not** bundle Chromium, so run `npx playwright install chromium` once after
installing it that way.

### Remote / Streamable HTTP

Default transport is stdio. For a hosted deployment, run it over Streamable HTTP:

```bash
node dist/index.js --http 8080      # or: MCP_TRANSPORT=http PORT=8080 node dist/index.js
#   POST  http://<host>:8080/mcp    — JSON-RPC (stateless, no sessions)
#   GET   http://<host>:8080/health — liveness
```


---

## Tools

Both tools are annotated `readOnlyHint: true` — they never write, book, or pay.

### `cuddlynest_search`

Search stays, attractions or flights for a destination. `vertical` picks what to
search and `source` picks where the data comes from.

| Parameter | Required | Description |
| --- | --- | --- |
| `destination` | yes | City / area string, e.g. `"Cartagena, Colombia"` (for flights: where you fly to) |
| `vertical` | no | `"stays"` (default), `"attractions"` or `"flights"` |
| `source` | no | `"auto"` (default), `"db"` or `"live"` — see below |
| `limit` | no | Max results (default 20 for stays/attractions, 10 for flights; max 50) |
| `origin` | flights | Departure city or IATA code, e.g. `"Bogotá"` or `"BOG"` |
| `cabinClass` | no | Flights: `economy` (default), `premium_economy`, `business`, `first` |
| `checkin`, `checkout` | live stays, flights | `YYYY-MM-DD`. Flights: departure / return date (omit `checkout` for one way) |
| `adults`, `children`, `childAges`, `infants`, `rooms`, `currency` | no | Guests / passengers. Flights need `childAges` when travelling with children |
| `hotelsOnly`, `fullCityList` | no | Stays from the public-site fallback only |

**Sources**

| `source` | Stays | Attractions | Flights |
| --- | --- | --- | --- |
| `auto` | Catalog DB (cached per destination); falls back to the public site if the DB fails, has no results or the destination is ambiguous | Cache of earlier live searches (24 h, refreshed in the background in HTTP mode) | Cache of earlier live searches (30 min, indicative fares) |
| `db` | Catalog DB only; an error instead of a fallback | same as `auto` | same as `auto` |
| `live` | Real-time availability with prices (needs dates) | Tours and activities with a from-price | Real-time fares |

`live` calls CuddlyNest's real-time APIs, which reach travel suppliers, so it is
only used when a caller asks for it explicitly and never as an automatic
fallback. Attractions and flights have no catalog database (their inventory
comes from suppliers), so `auto` / `db` answer from a cache of earlier `live`
searches and never call the API; a cache miss answers `source: "unavailable"`
with `reason: "<vertical>_not_cached"`. Cached results carry `cachedAt`. A failed `live` search returns an error with `liveErrorCode`; it never
falls back to another source.

**Returns** (all verticals share the same static shape, and prices only ever
appear under each result's `pricing`):

- **Stays:** `stays[]` with `id`, `type`, `name`, `slug`, `category`,
  `location { city, country, lat, lng, nearest_airport }`, `tags`,
  `description_short`, `amenities`, `rating` (/10), `cover_image_url`, `url`;
  live results add `details` (neighborhood, distance, reviews, nearby places)
  and `pricing`.
- **Attractions:** `attractions[]` with the same static fields plus `duration`,
  `rating` (/5), `details` (reviews, sub-categories, languages, accessibility)
  and `pricing` (from-price, currency, availability, priced date).
- **Flights:** `flights[]` with `legs[]` (airports, local times, duration,
  stops, `segments[]` with carrier and flight number), `airlines`, `baggage`,
  `conditions` (refundable / changeable) and `pricing` (total, base, taxes, per
  passenger, price guarantee expiry), plus the search `sessionId`.
- `vertical` / `source` combinations with no data source answer
  `source: "unavailable"` with a `reason` and empty `results`.

### `cuddlynest_listing_details`

Static basics **and** rooms/pricing for one hotel.

| Parameter | Required | Description |
| --- | --- | --- |
| `hotel` | yes | Listing URL **or** numeric `product_id` (trailing number in the URL) |
| `checkin`, `checkout` | for pricing | `YYYY-MM-DD` — required to read rooms/prices |
| `adults`, `children`, `childAges`, `infants`, `rooms` | no | defaults 2 / 0 / – / 0 / 1 |
| `currency` | no | ISO 4217, default `USD` |
| `ignoreRobotsText` | no | ignore robots.txt for the static fetch |

**Returns:** `{ productId, hotelUrl, guests, staticListing, staticError, rooms, roomsError, notes }`.
`rooms.units[]` is the extracted room offers, each with `title`, `partnerName`,
`unitPrice`, `currency`, `remainingRooms`, `guests`, `cancellationPolicyType`,
`cancellationPolicyText`, `priceBreakdown`, `roomFilters`. `rooms` also carries
`fromPrice`, `partnersSeen`, `listingUrl`, `scrapedAt`. With the booking tools
enabled, each unit adds `bookingOptions[]` (one per rate: meal plan and
cancellation type, price, and the `offer` ids `cuddlynest_booking_checkout` takes).

---

## Development

```bash
npm install          # installs deps + Chromium (postinstall)
npm run build        # sync-version + tsc -> dist/
npm run typecheck
npm test             # offline: smoke test (stdio) + scraper tests
npm run e2e:sansiraka # ONLINE: real scrape of cuddlynest.com, structural asserts
npm run watch
```


## Architecture

- `index.ts` — MCP server, tool schemas, stdio **and** Streamable HTTP transports,
  `robots.txt` handling
- `cuddlynest.ts` — hotel-URL parsing, static-listing `ld+json` parse,
  destination autosuggestion, result shaping
- `scrape-listing.ts` — `resolveListingPath`, `buildListingUrl`, `scrapeListing`
  (headless browser), `extractRoomsFromDom` (React-fiber walk)
- `util.ts` — generic object/JSON helpers
- `db.ts`, `cache.ts`, `destination.ts` — read-only catalog DB for stays, the
  JSON caches (stays, attractions, flights) with age-based expiry, and destination parsing
- `fallback-provider.ts` — public-site fallback for `source: "auto"`
- `auth.ts` — service JWT (fetched with an API key, cached, renewed before expiry)
- `be-api-provider.ts` — live stays availability (`source: "live"`)
- `attractions-provider.ts`, `flights-provider.ts` — live attractions and flights search
- `booking.ts` — stays booking: a room rate → Request to Book → CuddlyNest
  checkout link, where the user sees the final price and pays. Hidden unless
  `CUDDLYNEST_ENABLE_BOOKING_TOOLS=true`; booking status has no API yet
- `attractions-booking.ts`, `flights-booking.ts` — attraction options →
  live availability → checkout, and flight live price → pending booking, behind
  the same flag. The payment hand-off is pending, so both stop before payment


## License

MIT — see [LICENSE](LICENSE).
