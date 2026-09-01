# CuddlyNest Search & Listings — MCP Server

A Model Context Protocol (MCP) server for searching [CuddlyNest](https://www.cuddlynest.com)
hotels and retrieving listing details, including **live room options, prices,
availability and cancellation policies**.

Read-only by design: search and listing details only. No booking, no payment.

> This project was seeded from the MCP server scaffolding of
> [`openbnb-org/mcp-server-airbnb`](https://github.com/openbnb-org/mcp-server-airbnb)
> (MIT). The MCP transport/registration layer is reused; the data-fetching layer
> is a full rewrite, because CuddlyNest works nothing like Airbnb — see
> [How CuddlyNest serves data](#how-cuddlynest-serves-data). The original
> copyright notice is retained in [LICENSE](LICENSE) per the MIT terms.

---

## Status

| Capability | State |
| --- | --- |
| MCP server / stdio transport / tool registration | ✅ working |
| `cuddlynest_listing_details` — product_id parsing | ✅ working |
| `cuddlynest_listing_details` — static basics (name, location, amenities, images) via schema.org ld+json | ✅ working (verified against a live hotel) |
| `cuddlynest_listing_details` — `sessionid` + destination slug + outgoing frame | ✅ built, matches captures + a live A/B |
| `cuddlynest_listing_details` — live rooms/pricing WebSocket + partial-message merge | ✅ wired to `wss://ldp.cuddlynest.com/websocket/ldp_room_groups`; **needs an access token** (below) |
| `cuddlynest_search` — destination resolution + slug | ✅ working (autosuggestion API) |
| `cuddlynest_search` — hotel enumeration with prices | 🔌 protocol not captured |

### The one thing still needed: the access token

The WebSocket requires `?access_token=<JWT>` — an **anonymous** RS256 app token
(`sub: "web"`, ~1h TTL, issuer `jwt-issuer.cuddlynest.com`; not tied to a user
account). It is minted **in-browser at page bootstrap** and is **not** in the
server-rendered HTML, so the server cannot scrape it. Until the token-issuance
call is captured (DevTools → Network, filter by `jwt-issuer`, on a cold page
load), pass a token you copied from a live session:

```
CUDDLYNEST_ACCESS_TOKEN=eyJ...   # env
# or
--access-token eyJ...            # arg
```

Everything else (endpoint URL, outgoing frame shape, sessionid, terminal-status
detection) is captured and implemented.

## How CuddlyNest serves data

1. **Pricing and room availability are not in the static HTML** and are **not a
   normal REST/XHR call**. They arrive over a **WebSocket**
   (`wss://ldp.cuddlynest.com/websocket/ldp_room_groups?access_token=<JWT>`) as a
   stream of `Connection.Message` events, delivered to a dedicated Web Worker
   which forwards them to the page via `postMessage`. The single outgoing request
   frame mirrors the `payload.data` object the page hands that Worker.
2. CuddlyNest does **not own the inventory** — prices come from third-party
   wholesale suppliers (observed: `dida travels`, `hotelplanner`, `ratehawk`,
   `hxpro`). Each supplier answers at its own pace, so **one search produces
   several `"partial"` messages** that must be accumulated and merged. The final
   frame has `payload.status === "success"` **and** `payload.data.streaming_status
   === "complete"`, after which the server closes the socket (~3s total).
3. The hotel `product_id` is the **trailing number in a listing URL**, e.g.
   `https://www.cuddlynest.com/hotel/us/le-meridien-boston-cambridge-4264955` →
   `4264955`. No separate lookup needed.
4. A search is keyed by a `sessionid` string:

   ```
   room_groups_:{destination_slug}:{children}:{infants}:{adults}:{rooms}:{property_type}:viewport:{currency}:{hotel_product_id}:{checkin}:{checkout}:{currency_lowercase}

   room_groups_:SantaMartaMagdalenaColombia:0:0:2:1:Hotel:viewport:COP:4395541:2026-10-05:2026-10-08:cop
   ```

   `children:infants:adults:rooms` order confirmed by a live A/B capture.
5. `{destination_slug}` is built **client-side** as `name + state + country` with
   separators and non-alphanumerics stripped (`Santa Marta` + `Magdalena` +
   `Colombia` → `SantaMartaMagdalenaColombia`) — **not** the `slug` the
   autosuggestion API returns. `cuddlynest_listing_details` derives it from the
   listing page's schema.org address (expanding the ISO country code, e.g.
   `CO` → `Colombia`).

## Still uncaptured

- **Access token issuance** — see [the status section](#the-one-thing-still-needed-the-access-token).
- **Destination-level search** — `cuddlynest_search` resolves the destination and
  slug via `autosuggestion-2-0.cuddlynest.com` (no auth), but the protocol that
  enumerates a destination's hotels *with prices* is not captured. Capture the WS
  frame(s) fired from a city results page (as opposed to a single hotel page).

## Tools

### `cuddlynest_search`

Resolve a destination to its CuddlyNest candidates (name, city/state/country,
`sessionidSlug`, coordinates, property count) via the autosuggestion API.

| Parameter | Required | Description |
| --- | --- | --- |
| `destination` | yes | City / area string, e.g. `"Santa Marta, Colombia"` |
| `checkin`, `checkout` | no | `YYYY-MM-DD` (echoed for downstream use) |
| `adults`, `children`, `childAges`, `infants`, `rooms` | no | defaults: 2 / 0 / – / 0 / 1 |
| `currency` | no | ISO 4217, default `USD` |

**Returns:** `{ query, guests, candidates[], note, openQuestions }`. Enumerating a
destination's hotels with prices needs a further capture (see [Still uncaptured](#still-uncaptured)).

### `cuddlynest_listing_details`

Get static basics **and** live rooms/pricing for one hotel.

| Parameter | Required | Description |
| --- | --- | --- |
| `hotel` | yes | Listing URL **or** numeric `product_id` |
| `checkin`, `checkout` | for pricing | `YYYY-MM-DD` — required to fetch rooms/prices |
| `destinationSlug` | no | Overrides the slug derived from the listing page |
| `adults`, `children`, `childAges`, `infants`, `rooms` | no | defaults: 2 / 0 / – / 0 / 1 |
| `currency` | no | ISO 4217, default `USD` |

**Returns:** `{ productId, hotelUrl, destinationSlug, guests, staticListing, rooms, notes, openQuestions, … }`.
`rooms.units[]` is the merged, deduped, price-sorted set of room offers, each with
`title`, `partnerName`, `unitPrice`, `currency`, `remainingRooms`, `roomSize`,
`cancellationPolicyType`, `cancellationPolicyText`, `priceBreakdown`, `amenities`,
`images`. Without an access token, `roomsError` explains what to supply.

## Installation

Requires [Node.js](https://nodejs.org/) 18+.

```json
{
  "mcpServers": {
    "cuddlynest": {
      "command": "npx",
      "args": ["-y", "@cuddlynest/mcp-server-cuddlynest"]
    }
  }
}
```

To ignore `robots.txt` (listing-page fetches only), add `"--ignore-robots-txt"`
to `args`. To enable live pricing, add `"--access-token", "eyJ…"` or set
`CUDDLYNEST_ACCESS_TOKEN` (see [the status section](#the-one-thing-still-needed-the-access-token)).

## Development

```bash
npm install
npm run build      # sync-version + tsc
npm test           # smoke test (stdio) + offline merge/sessionid tests
npm run watch
```

`test-merge.js` runs fully offline against the captured payloads in `fixtures/`.
`test-extension.js` drives the built server over stdio (the listing-details case
makes one HTTP request to `cuddlynest.com`).

## Architecture

- **Runtime:** Node.js 18+
- **Protocol:** MCP over stdio
- `index.ts` — MCP server, tool schemas, request routing, `robots.txt` handling
- `cuddlynest.ts` — hotel-URL parsing, `sessionid` construction, static-listing
  Cheerio parse, result shaping
- `rooms-ws.ts` — WebSocket client + outgoing frame builder + partial-message
  accumulation/merge
- `util.ts` — generic object/JSON helpers

## Legal

- This project is **not affiliated with CuddlyNest**. It is an independent tool
  for retrieving publicly available listing information.
- Respects `robots.txt` by default for listing-page fetches (override for testing).
- Be mindful of request frequency.

## License

MIT — see [LICENSE](LICENSE).
