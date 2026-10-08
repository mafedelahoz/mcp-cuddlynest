import {
  resolveDestinations,
  searchHotels,
  resolveCityGeoId,
  fetchGeopageHotels,
  geopageMatchesPlace,
  pickAnchorPlace,
  mergeHotelCandidates,
  type DestinationCandidate,
  type HotelCandidate,
} from "./cuddlynest.js";

export type Vertical = "stays" | "flights" | "attractions";

export type Log = (level: "info" | "warn" | "error", message: string, data?: any) => void;

export interface StaysFallbackRequest {
  destination: string;
  /** Also widen the list with the city's full hotel list when the provider can. */
  fullCityList: boolean;
  log: Log;
}

export interface StaysFallbackResult {
  places: DestinationCandidate[];
  city?: {
    label?: string;
    city?: string;
    state?: string;
    country?: string;
    totalProperties?: number;
  };
  hotelSource: string;
  hotels: HotelCandidate[];
}

export interface FallbackSearchProvider {
  /** Reported as `provider` in tool results. */
  readonly name: string;
  readonly provisional: boolean;
  readonly verticals: readonly Vertical[];
  /** Throws on failure; the caller turns that into a tool error. */
  searchStays(req: StaysFallbackRequest): Promise<StaysFallbackResult>;
}

// ---------------------------------------------------------------------------
// Provisional: public-site scraping (autosuggest + geo page)
// ---------------------------------------------------------------------------

export const scrapeFallbackProvider: FallbackSearchProvider = {
  name: "scrape",
  provisional: true,
  verticals: ["stays"],

  async searchStays({ destination, fullCityList, log }) {
    let places: DestinationCandidate[];
    let hotels: HotelCandidate[];
    try {
      [places, hotels] = await Promise.all([
        resolveDestinations(destination),
        searchHotels(destination),
      ]);
    } catch (e) {
      throw new Error(`Autosuggestion lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const anchor = pickAnchorPlace(destination, places);

    let hotelSource: "autosuggest" | "autosuggest+geopage" = "autosuggest";
    let city: StaysFallbackResult["city"];
    if (fullCityList && hotels.length > 0) {
      try {
        const enrich = (async () => {
          const geoIds = [
            ...new Set(
              (
                await Promise.all(hotels.slice(0, 4).map((h) => resolveCityGeoId(h.productId)))
              ).filter((id): id is string => !!id),
            ),
          ].slice(0, 2);
          for (const geoId of geoIds) {
            const gp = await fetchGeopageHotels(geoId);
            if (gp.hotels.length && geopageMatchesPlace(gp, anchor, destination)) {
              hotels = mergeHotelCandidates(hotels, gp.hotels);
              hotelSource = "autosuggest+geopage";
              city = {
                label: gp.cityLabel,
                city: gp.city,
                state: gp.state,
                country: gp.country,
                totalProperties: gp.propertyCount,
              };
              return;
            }
          }
        })();
        await Promise.race([
          enrich,
          new Promise((_, rej) => setTimeout(() => rej(new Error("geo-page budget exceeded")), 12000)),
        ]);
      } catch (e) {
        log("warn", "geo-page enrichment skipped", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { places, city, hotelSource, hotels };
  },
};

export const fallbackSearchProvider: FallbackSearchProvider = scrapeFallbackProvider;
