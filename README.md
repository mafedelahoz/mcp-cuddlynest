# CuddlyNest Search & Listings — MCP Server

[![npm](https://img.shields.io/npm/v/cuddlynest-mcp)](https://www.npmjs.com/package/cuddlynest-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.mafedelahoz%2Fcuddlynest--mcp-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=cuddlynest)

A Model Context Protocol (MCP) server for searching [CuddlyNest](https://www.cuddlynest.com)
hotels and retrieving listing details, including **room options, prices,
availability and cancellation policies**.

Read-only by design: search and listing details only. No booking, no payment.


## How it gets the data

CuddlyNest does not serve room prices in its static HTML. Pricing renders
client-side on the **public listing page**, backed by the site's own
infrastructure and third-party wholesale suppliers (`dida travels`,
`hotelplanner`, `ratehawk`, `hxpro`, `rakuten`, …).

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

The `Dockerfile` defaults to this mode (`MCP_TRANSPORT=http`, `PORT=8080`). There
is no auth layer yet — put it behind a gateway, or see
[Toward a hosted / directory-listed server](#toward-a-hosted--directory-listed-server).

---

## Tools

Both tools are annotated `readOnlyHint: true` — they never write, book, or pay.

### `cuddlynest_search`

Search a destination and the top hotels there, from public CuddlyNest APIs
(`autosuggestion-2-0` for the fuzzy match, `discovery-pages` geo pages for the
broader city list). Prices are **not** here — pass a hotel's `productId` to
`cuddlynest_listing_details`.

| Parameter | Required | Description |
| --- | --- | --- |
| `destination` | yes | City / area string, e.g. `"Cartagena, Colombia"` |
| `hotelsOnly` | no | Omit the `places[]` block (default `false`) |
| `fullCityList` | no | Also pull the geo-page city list (~60–250 hotels) when it can be resolved and verified against the destination — a few extra requests (default `true`) |
| `checkin`, `checkout`, `adults`, `children`, `childAges`, `infants`, `rooms`, `currency` | no | echoed back for downstream use |

**Returns:** `{ query, guests, places[], city, hotelSource, hotelCount, hotels[], note }`.
Each `hotels[]` entry: `productId`, `name`, `url`, `slug`, `propertyType`,
`starRating`, `guestRating` (/10) + `guestRatingText`, `reviewCount`, and — from
the geo page — `images[]`, `distanceFromCenterKm`, `featuredAmenities[]`.
`hotelSource` is `"autosuggest"` or `"autosuggest+geopage"`. The list is
top-matches scale, **not** full inventory — CuddlyNest's real results page
(`/sr/…`) is bot-blocked and `Disallow`ed in robots.txt.

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
`fromPrice`, `partnersSeen`, `listingUrl`, `scrapedAt`.

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

- `test-scrape.js` — `buildListingUrl` (pure) + `extractRoomsFromDom` replayed
  against `fixtures/hotel-sansiraka-2026-10-05.json` (a **real** capture from
  cuddlynest.com on 2026-09-01: Hotel Sansiraka `4395541`, 2026-10-05→08, 2
  adults + 1 child age 2, COP — 9 rooms across dida travels / hxpro / ratehawk /
  rakuten). A local headless Chromium rebuilds the page's DOM+fiber shape from
  that fixture and checks the extractor reconstructs it — no network.
- `test-extension.js` — MCP handshake, tool listing, `cuddlynest_search`
  (hits the autosuggestion API), `cuddlynest_listing_details` product_id parsing.
- `scripts/e2e-hotel-sansiraka.mjs` — runs a real scrape of the Sansiraka
  listing and asserts the live result matches the fixture's **structure** (room
  object shape/keys, non-empty, partner variety). Live prices and the exact
  partner set drift from the fixture — that's expected.


## Architecture

- `index.ts` — MCP server, tool schemas, stdio **and** Streamable HTTP transports,
  `robots.txt` handling
- `cuddlynest.ts` — hotel-URL parsing, static-listing `ld+json` parse,
  destination autosuggestion, result shaping
- `scrape-listing.ts` — `resolveListingPath`, `buildListingUrl`, `scrapeListing`
  (headless browser), `extractRoomsFromDom` (React-fiber walk)
- `util.ts` — generic object/JSON helpers


## Toward a hosted / directory-listed server

Listing in **claude.ai's Connectors Directory** (and equivalents) needs a hosted
**remote** server, not a local `npx` one. Progress:

| Requirement | State |
| --- | --- |
| Streamable HTTP transport | ✅ `--http` / `MCP_TRANSPORT=http` |
| Container image | ✅ `Dockerfile` (HTTP by default, `EXPOSE 8080`) |
| Tool annotations (`title`, `readOnlyHint`) | ✅ both tools |
| Published npm package + MCP registry entry | ✅ |
| Hosted at a stable HTTPS URL | ☐ needs infra — the per-request headless browser (~15 s, ~500 MB image) rules out most serverless; use a small always-on container |
| OAuth 2.0 (or a documented no-auth stance for read-only public data) | ☐ |
| Public privacy policy at a live URL | ☐ **hard requirement — missing = auto-reject** |
| Public docs page + 3 example prompts + reviewer demo account | ☐ |
| Submitted by the resource owner (CuddlyNest) from a Team/Enterprise org | ☐ the connector reads cuddlynest.com — Anthropic requires the owner to submit |

See Anthropic's [Connectors Directory submission guide](https://claude.com/docs/connectors/building/submission).


## License

MIT — see [LICENSE](LICENSE).
