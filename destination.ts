// Supports "City", "City, Country", "City, State" and "City, State, Country".
// The second part of a two-part query is classified locally (no DB round trip):
// a country name/ISO code -> m_country, a US state or any other text -> m_state.
// When it can't tell ("Atlanta, Georgia", "Denver, CO" — both a country and a
// US state) the result is "ambiguous" and the caller skips the DB.

export type ParsedDestination =
  | { kind: "ok"; city: string; state?: string; country?: string; key: string }
  | { kind: "ambiguous"; city: string; reason: string };

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

// Where fc_product.m_country spells a country differently from Intl's English name.
const DB_COUNTRY_NAME: Record<string, string> = {
  Türkiye: "Turkey",
  Czechia: "Czech Republic",
  "Hong Kong SAR China": "Hong Kong",
  "Macao SAR China": "Macau",
  "Myanmar (Burma)": "Myanmar",
};

const EXTRA_COUNTRY_ALIASES: Record<string, string> = {
  usa: "United States",
  "u.s.": "United States",
  "u.s.a.": "United States",
  "united states of america": "United States",
  eeuu: "United States",
  "ee.uu.": "United States",
  "ee. uu.": "United States",
  uk: "United Kingdom",
  england: "United Kingdom",
  scotland: "United Kingdom",
  wales: "United Kingdom",
  holland: "Netherlands",
};

// Not real countries, though Intl names them.
const NON_COUNTRY_CODES = new Set(["EU", "EZ", "UN", "QO", "ZZ"]);

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

let countryIndex: Map<string, string> | undefined;

/** Lower-cased English/Spanish country names and ISO-2 codes -> DB country name. */
function getCountryIndex(): Map<string, string> {
  if (countryIndex) return countryIndex;
  const index = new Map<string, string>();
  const en = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const es = new Intl.DisplayNames(["es"], { type: "region", fallback: "none" });
  const A = "A".charCodeAt(0);
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j);
      if (NON_COUNTRY_CODES.has(code)) continue;
      const name = en.of(code);
      if (!name) continue;
      const dbName = DB_COUNTRY_NAME[name] ?? name;
      index.set(code.toLowerCase(), dbName);
      index.set(norm(name), dbName);
      index.set(norm(dbName), dbName); // "Turkey" as well as "Türkiye"
      const esName = es.of(code);
      if (esName) index.set(norm(esName), dbName);
    }
  }
  for (const [alias, name] of Object.entries(EXTRA_COUNTRY_ALIASES)) index.set(alias, name);
  return (countryIndex = index);
}

const US_STATE_BY_NAME = new Map(Object.values(US_STATES).map((n) => [norm(n), n]));

function asCountry(part: string): string | undefined {
  return getCountryIndex().get(norm(part));
}

function asUsState(part: string): string | undefined {
  const t = part.trim();
  if (/^[A-Za-z]{2}$/.test(t)) return US_STATES[t.toUpperCase()];
  return US_STATE_BY_NAME.get(norm(t));
}

export function parseDestination(destination: string): ParsedDestination {
  const parts = String(destination)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const city = parts[0] ?? "";
  if (!city) return { kind: "ambiguous", city, reason: "empty destination" };

  let state: string | undefined;
  let country: string | undefined;

  if (parts.length >= 3) {
    // "City, State, Country" (anything between the first and the last two parts is ignored).
    const last = parts[parts.length - 1];
    country = asCountry(last);
    if (!country) {
      return {
        kind: "ambiguous",
        city,
        reason: `"${last}" is not a recognized country`,
      };
    }
    const statePart = parts[parts.length - 2];
    state = (country === "United States" && asUsState(statePart)) || statePart;
  } else if (parts.length === 2) {
    const second = parts[1];
    const asC = asCountry(second);
    const asS = asUsState(second);
    if (asC && asS) {
      return {
        kind: "ambiguous",
        city,
        reason:
          `"${second}" is both a country (${asC}) and a US state (${asS}); ` +
          `use "City, State, Country" to disambiguate`,
      };
    }
    if (asC) country = asC;
    // A US state, or free text taken as a state/region ("Cancún, Quintana Roo").
    else state = asS ?? second;
  }

  const key = [city, state ?? "", country ?? ""].map(norm).join("|");
  return { kind: "ok", city, state, country, key };
}
