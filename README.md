# CuddlyNest Search & Listings — MCP Server

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
| Destination → city/state/country/coords/slug | `autosuggestion-2-0.cuddlynest.com` (public, no auth) |
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

---

## Tools

### `cuddlynest_search`

Resolve a destination to its CuddlyNest candidates via the public autosuggestion
API — name, city/state/country, coordinates, property count.

| Parameter | Required | Description |
| --- | --- | --- |
| `destination` | yes | City / area string, e.g. `"Santa Marta, Colombia"` |
| `checkin`, `checkout`, `adults`, `children`, `childAges`, `infants`, `rooms`, `currency` | no | echoed back for downstream use |

**Returns:** `{ query, guests, candidates[], note }`. This tool does **not**
enumerate a destination's hotels — call `cuddlynest_listing_details` for a
specific hotel.

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

- `index.ts` — MCP server, tool schemas, routing, `robots.txt` handling
- `cuddlynest.ts` — hotel-URL parsing, static-listing `ld+json` parse,
  destination autosuggestion, result shaping
- `scrape-listing.ts` — `resolveListingPath`, `buildListingUrl`, `scrapeListing`
  (headless browser), `extractRoomsFromDom` (React-fiber walk)
- `util.ts` — generic object/JSON helpers


## License

MIT — see [LICENSE](LICENSE).
