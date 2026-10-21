// A lead's timezone, for "send in each lead's timezone": an explicit timezone when there is one (an IANA name, a
// common abbreviation like EST, or an offset like UTC+2), else worked out from where they are (country, then the
// state for the US, Canada and Australia, or a big US city) or from the country code of their phone number. Countries
// that span several timezones only count when one holds most people (Brazil, Mexico, Russia, Indonesia).

/** The canonical IANA name for a timezone, or null when it isn't one. */
export function canonicalZone(zone: string | null | undefined): string | null {
  const z = (zone ?? "").trim();
  if (!z || z.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: z }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const ABBREVIATIONS: Record<string, string> = {
  et: "America/New_York",
  est: "America/New_York",
  edt: "America/New_York",
  eastern: "America/New_York",
  ct: "America/Chicago",
  cst: "America/Chicago",
  cdt: "America/Chicago",
  central: "America/Chicago",
  mt: "America/Denver",
  mst: "America/Denver",
  mdt: "America/Denver",
  mountain: "America/Denver",
  pt: "America/Los_Angeles",
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  pacific: "America/Los_Angeles",
  akst: "America/Anchorage",
  akdt: "America/Anchorage",
  hst: "Pacific/Honolulu",
  utc: "UTC",
  z: "UTC",
  gmt: "Europe/London",
  bst: "Europe/London",
  wet: "Europe/Lisbon",
  west: "Europe/Lisbon",
  cet: "Europe/Paris",
  cest: "Europe/Paris",
  eet: "Europe/Athens",
  eest: "Europe/Athens",
  msk: "Europe/Moscow",
  ist: "Asia/Kolkata",
  pkt: "Asia/Karachi",
  sgt: "Asia/Singapore",
  hkt: "Asia/Hong_Kong",
  jst: "Asia/Tokyo",
  kst: "Asia/Seoul",
  aest: "Australia/Sydney",
  aedt: "Australia/Sydney",
  acst: "Australia/Adelaide",
  acdt: "Australia/Adelaide",
  awst: "Australia/Perth",
  nzst: "Pacific/Auckland",
  nzdt: "Pacific/Auckland",
  brt: "America/Sao_Paulo",
  art: "America/Argentina/Buenos_Aires",
  gst: "Asia/Dubai",
  sast: "Africa/Johannesburg",
  wat: "Africa/Lagos",
  eat: "Africa/Nairobi",
};

/** Offsets that aren't whole hours, by minutes east of UTC. */
const ODD_OFFSETS: Record<number, string> = {
  330: "Asia/Kolkata",
  345: "Asia/Kathmandu",
  210: "Asia/Tehran",
  270: "Asia/Kabul",
  390: "Asia/Yangon",
  525: "Australia/Eucla",
  570: "Australia/Darwin",
  630: "Australia/Lord_Howe",
  765: "Pacific/Chatham",
  [-210]: "America/St_Johns",
  [-570]: "Pacific/Marquesas",
};

/** An explicit timezone as people write it: "Europe/Berlin", "EST", "UTC+2", "GMT-05:00", "+05:30". */
export function parseTimezone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.includes("/")) return canonicalZone(raw.replace(/\s+/g, "_"));
  const key = raw
    .toLowerCase()
    .replace(/\s*\(.*\)\s*$/, "")
    .replace(/[.\s]+/g, " ")
    .replace(/ (standard |daylight )?time$/, "")
    .trim();
  if (ABBREVIATIONS[key]) return ABBREVIATIONS[key];
  const m = /^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(key);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    const minutes = sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
    if (!minutes) return "UTC";
    if (minutes % 60) return ODD_OFFSETS[minutes] ?? null;
    const hours = minutes / 60;
    if (hours < -12 || hours > 14) return null;
    // Etc zones count the other way round: UTC+2 is Etc/GMT-2.
    return `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`;
  }
  return canonicalZone(raw);
}

/** Countries in one timezone (or one most people live in), by ISO code. */
const COUNTRY_ZONES: Record<string, string> = {
  GB: "Europe/London",
  IE: "Europe/Dublin",
  DE: "Europe/Berlin",
  FR: "Europe/Paris",
  ES: "Europe/Madrid",
  PT: "Europe/Lisbon",
  IT: "Europe/Rome",
  NL: "Europe/Amsterdam",
  BE: "Europe/Brussels",
  LU: "Europe/Luxembourg",
  CH: "Europe/Zurich",
  AT: "Europe/Vienna",
  DK: "Europe/Copenhagen",
  SE: "Europe/Stockholm",
  NO: "Europe/Oslo",
  FI: "Europe/Helsinki",
  IS: "Atlantic/Reykjavik",
  PL: "Europe/Warsaw",
  CZ: "Europe/Prague",
  SK: "Europe/Bratislava",
  HU: "Europe/Budapest",
  RO: "Europe/Bucharest",
  BG: "Europe/Sofia",
  GR: "Europe/Athens",
  HR: "Europe/Zagreb",
  SI: "Europe/Ljubljana",
  RS: "Europe/Belgrade",
  UA: "Europe/Kiev",
  EE: "Europe/Tallinn",
  LV: "Europe/Riga",
  LT: "Europe/Vilnius",
  MT: "Europe/Malta",
  CY: "Asia/Nicosia",
  TR: "Europe/Istanbul",
  RU: "Europe/Moscow",
  IL: "Asia/Jerusalem",
  AE: "Asia/Dubai",
  SA: "Asia/Riyadh",
  QA: "Asia/Qatar",
  KW: "Asia/Kuwait",
  BH: "Asia/Bahrain",
  OM: "Asia/Muscat",
  EG: "Africa/Cairo",
  ZA: "Africa/Johannesburg",
  NG: "Africa/Lagos",
  KE: "Africa/Nairobi",
  GH: "Africa/Accra",
  MA: "Africa/Casablanca",
  IN: "Asia/Kolkata",
  PK: "Asia/Karachi",
  BD: "Asia/Dhaka",
  LK: "Asia/Colombo",
  NP: "Asia/Kathmandu",
  SG: "Asia/Singapore",
  MY: "Asia/Kuala_Lumpur",
  TH: "Asia/Bangkok",
  VN: "Asia/Ho_Chi_Minh",
  PH: "Asia/Manila",
  ID: "Asia/Jakarta",
  HK: "Asia/Hong_Kong",
  TW: "Asia/Taipei",
  CN: "Asia/Shanghai",
  JP: "Asia/Tokyo",
  KR: "Asia/Seoul",
  NZ: "Pacific/Auckland",
  MX: "America/Mexico_City",
  BR: "America/Sao_Paulo",
  AR: "America/Argentina/Buenos_Aires",
  CL: "America/Santiago",
  CO: "America/Bogota",
  PE: "America/Lima",
  UY: "America/Montevideo",
  VE: "America/Caracas",
  EC: "America/Guayaquil",
  CR: "America/Costa_Rica",
  PA: "America/Panama",
  DO: "America/Santo_Domingo",
  PR: "America/Puerto_Rico",
  JM: "America/Jamaica",
};

/** Country names and other ways people write them, to ISO codes. */
const COUNTRY_NAMES: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  america: "US",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  canada: "CA",
  australia: "AU",
  ireland: "IE",
  "republic of ireland": "IE",
  germany: "DE",
  deutschland: "DE",
  france: "FR",
  spain: "ES",
  espana: "ES",
  portugal: "PT",
  italy: "IT",
  italia: "IT",
  netherlands: "NL",
  "the netherlands": "NL",
  holland: "NL",
  belgium: "BE",
  luxembourg: "LU",
  switzerland: "CH",
  austria: "AT",
  denmark: "DK",
  sweden: "SE",
  norway: "NO",
  finland: "FI",
  iceland: "IS",
  poland: "PL",
  czechia: "CZ",
  "czech republic": "CZ",
  slovakia: "SK",
  hungary: "HU",
  romania: "RO",
  bulgaria: "BG",
  greece: "GR",
  croatia: "HR",
  slovenia: "SI",
  serbia: "RS",
  ukraine: "UA",
  estonia: "EE",
  latvia: "LV",
  lithuania: "LT",
  malta: "MT",
  cyprus: "CY",
  turkey: "TR",
  turkiye: "TR",
  russia: "RU",
  "russian federation": "RU",
  israel: "IL",
  "united arab emirates": "AE",
  uae: "AE",
  "saudi arabia": "SA",
  qatar: "QA",
  kuwait: "KW",
  bahrain: "BH",
  oman: "OM",
  egypt: "EG",
  "south africa": "ZA",
  nigeria: "NG",
  kenya: "KE",
  ghana: "GH",
  morocco: "MA",
  india: "IN",
  pakistan: "PK",
  bangladesh: "BD",
  "sri lanka": "LK",
  nepal: "NP",
  singapore: "SG",
  malaysia: "MY",
  thailand: "TH",
  vietnam: "VN",
  "viet nam": "VN",
  philippines: "PH",
  indonesia: "ID",
  "hong kong": "HK",
  taiwan: "TW",
  china: "CN",
  japan: "JP",
  "south korea": "KR",
  korea: "KR",
  "republic of korea": "KR",
  "new zealand": "NZ",
  mexico: "MX",
  brazil: "BR",
  brasil: "BR",
  argentina: "AR",
  chile: "CL",
  colombia: "CO",
  peru: "PE",
  uruguay: "UY",
  venezuela: "VE",
  ecuador: "EC",
  "costa rica": "CR",
  panama: "PA",
  "dominican republic": "DO",
  "puerto rico": "PR",
  jamaica: "JM",
};

const US_STATES: Record<string, [string, string]> = {
  alabama: ["AL", "America/Chicago"],
  alaska: ["AK", "America/Anchorage"],
  arizona: ["AZ", "America/Phoenix"],
  arkansas: ["AR", "America/Chicago"],
  california: ["CA", "America/Los_Angeles"],
  colorado: ["CO", "America/Denver"],
  connecticut: ["CT", "America/New_York"],
  delaware: ["DE", "America/New_York"],
  "district of columbia": ["DC", "America/New_York"],
  florida: ["FL", "America/New_York"],
  georgia: ["GA", "America/New_York"],
  hawaii: ["HI", "Pacific/Honolulu"],
  idaho: ["ID", "America/Boise"],
  illinois: ["IL", "America/Chicago"],
  indiana: ["IN", "America/Indiana/Indianapolis"],
  iowa: ["IA", "America/Chicago"],
  kansas: ["KS", "America/Chicago"],
  kentucky: ["KY", "America/New_York"],
  louisiana: ["LA", "America/Chicago"],
  maine: ["ME", "America/New_York"],
  maryland: ["MD", "America/New_York"],
  massachusetts: ["MA", "America/New_York"],
  michigan: ["MI", "America/Detroit"],
  minnesota: ["MN", "America/Chicago"],
  mississippi: ["MS", "America/Chicago"],
  missouri: ["MO", "America/Chicago"],
  montana: ["MT", "America/Denver"],
  nebraska: ["NE", "America/Chicago"],
  nevada: ["NV", "America/Los_Angeles"],
  "new hampshire": ["NH", "America/New_York"],
  "new jersey": ["NJ", "America/New_York"],
  "new mexico": ["NM", "America/Denver"],
  "new york": ["NY", "America/New_York"],
  "north carolina": ["NC", "America/New_York"],
  "north dakota": ["ND", "America/Chicago"],
  ohio: ["OH", "America/New_York"],
  oklahoma: ["OK", "America/Chicago"],
  oregon: ["OR", "America/Los_Angeles"],
  pennsylvania: ["PA", "America/New_York"],
  "rhode island": ["RI", "America/New_York"],
  "south carolina": ["SC", "America/New_York"],
  "south dakota": ["SD", "America/Chicago"],
  tennessee: ["TN", "America/Chicago"],
  texas: ["TX", "America/Chicago"],
  utah: ["UT", "America/Denver"],
  vermont: ["VT", "America/New_York"],
  virginia: ["VA", "America/New_York"],
  washington: ["WA", "America/Los_Angeles"],
  "west virginia": ["WV", "America/New_York"],
  wisconsin: ["WI", "America/Chicago"],
  wyoming: ["WY", "America/Denver"],
};
const US_STATE_CODES: Record<string, string> = Object.fromEntries(Object.values(US_STATES).map(([code, zone]) => [code.toLowerCase(), zone]));

const CA_PROVINCES: Record<string, [string, string]> = {
  alberta: ["AB", "America/Edmonton"],
  "british columbia": ["BC", "America/Vancouver"],
  manitoba: ["MB", "America/Winnipeg"],
  "new brunswick": ["NB", "America/Moncton"],
  "newfoundland and labrador": ["NL", "America/St_Johns"],
  newfoundland: ["NL", "America/St_Johns"],
  "nova scotia": ["NS", "America/Halifax"],
  "northwest territories": ["NT", "America/Yellowknife"],
  nunavut: ["NU", "America/Iqaluit"],
  ontario: ["ON", "America/Toronto"],
  "prince edward island": ["PE", "America/Halifax"],
  quebec: ["QC", "America/Toronto"],
  saskatchewan: ["SK", "America/Regina"],
  yukon: ["YT", "America/Whitehorse"],
};
const CA_CODES: Record<string, string> = Object.fromEntries(Object.values(CA_PROVINCES).map(([code, zone]) => [code.toLowerCase(), zone]));

const AU_STATES: Record<string, [string, string]> = {
  "new south wales": ["NSW", "Australia/Sydney"],
  victoria: ["VIC", "Australia/Melbourne"],
  queensland: ["QLD", "Australia/Brisbane"],
  "south australia": ["SA", "Australia/Adelaide"],
  "western australia": ["WA", "Australia/Perth"],
  tasmania: ["TAS", "Australia/Hobart"],
  "australian capital territory": ["ACT", "Australia/Sydney"],
  "northern territory": ["NT", "Australia/Darwin"],
};
const AU_CODES: Record<string, string> = Object.fromEntries(Object.values(AU_STATES).map(([code, zone]) => [code.toLowerCase(), zone]));

/** Big US cities and areas, for locations without a state ("San Francisco Bay Area"). */
const US_CITIES: Record<string, string> = {
  "new york city": "America/New_York",
  nyc: "America/New_York",
  manhattan: "America/New_York",
  brooklyn: "America/New_York",
  boston: "America/New_York",
  philadelphia: "America/New_York",
  "washington dc": "America/New_York",
  atlanta: "America/New_York",
  miami: "America/New_York",
  charlotte: "America/New_York",
  pittsburgh: "America/New_York",
  detroit: "America/Detroit",
  chicago: "America/Chicago",
  houston: "America/Chicago",
  dallas: "America/Chicago",
  "dallas-fort worth": "America/Chicago",
  austin: "America/Chicago",
  "san antonio": "America/Chicago",
  nashville: "America/Chicago",
  minneapolis: "America/Chicago",
  "minneapolis-st paul": "America/Chicago",
  "st louis": "America/Chicago",
  "kansas city": "America/Chicago",
  denver: "America/Denver",
  boulder: "America/Denver",
  "salt lake city": "America/Denver",
  phoenix: "America/Phoenix",
  scottsdale: "America/Phoenix",
  "los angeles": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  "san francisco bay": "America/Los_Angeles",
  "bay area": "America/Los_Angeles",
  "silicon valley": "America/Los_Angeles",
  "san jose": "America/Los_Angeles",
  "san diego": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  "las vegas": "America/Los_Angeles",
  sacramento: "America/Los_Angeles",
  honolulu: "Pacific/Honolulu",
};

/** Big cities elsewhere, for locations that only name the city. */
const WORLD_CITIES: Record<string, string> = {
  london: "Europe/London",
  manchester: "Europe/London",
  edinburgh: "Europe/London",
  dublin: "Europe/Dublin",
  paris: "Europe/Paris",
  berlin: "Europe/Berlin",
  munich: "Europe/Berlin",
  hamburg: "Europe/Berlin",
  amsterdam: "Europe/Amsterdam",
  brussels: "Europe/Brussels",
  madrid: "Europe/Madrid",
  barcelona: "Europe/Madrid",
  lisbon: "Europe/Lisbon",
  milan: "Europe/Rome",
  rome: "Europe/Rome",
  zurich: "Europe/Zurich",
  vienna: "Europe/Vienna",
  copenhagen: "Europe/Copenhagen",
  stockholm: "Europe/Stockholm",
  oslo: "Europe/Oslo",
  helsinki: "Europe/Helsinki",
  warsaw: "Europe/Warsaw",
  prague: "Europe/Prague",
  istanbul: "Europe/Istanbul",
  "tel aviv": "Asia/Jerusalem",
  dubai: "Asia/Dubai",
  bangalore: "Asia/Kolkata",
  bengaluru: "Asia/Kolkata",
  mumbai: "Asia/Kolkata",
  delhi: "Asia/Kolkata",
  "new delhi": "Asia/Kolkata",
  hyderabad: "Asia/Kolkata",
  pune: "Asia/Kolkata",
  singapore: "Asia/Singapore",
  "hong kong": "Asia/Hong_Kong",
  tokyo: "Asia/Tokyo",
  seoul: "Asia/Seoul",
  shanghai: "Asia/Shanghai",
  beijing: "Asia/Shanghai",
  sydney: "Australia/Sydney",
  melbourne: "Australia/Melbourne",
  brisbane: "Australia/Brisbane",
  perth: "Australia/Perth",
  auckland: "Pacific/Auckland",
  toronto: "America/Toronto",
  vancouver: "America/Vancouver",
  montreal: "America/Toronto",
  calgary: "America/Edmonton",
  "mexico city": "America/Mexico_City",
  "sao paulo": "America/Sao_Paulo",
  "buenos aires": "America/Argentina/Buenos_Aires",
  bogota: "America/Bogota",
  santiago: "America/Santiago",
  lagos: "Africa/Lagos",
  nairobi: "Africa/Nairobi",
  "cape town": "Africa/Johannesburg",
  johannesburg: "Africa/Johannesburg",
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\./g, "")
    .replace(/^greater\s+/, "")
    .replace(/\s+(metropolitan area|metro area|metroplex|area|region|metro)$/, "")
    .replace(/\s+/g, " ")
    .trim();

/** A country as written (a name, or an ISO code when `codes` allows), to its ISO code. */
function countryCode(value: string, codes: boolean): string | null {
  const v = norm(value);
  if (COUNTRY_NAMES[v]) return COUNTRY_NAMES[v]!;
  const upper = v.toUpperCase();
  if (codes && /^[a-z]{2}$/.test(v) && (COUNTRY_ZONES[upper] || upper === "US" || upper === "CA" || upper === "AU")) return upper;
  return null;
}

/** A state, province or big city, within a country (or, with no country, as in the US, then elsewhere). */
function regionZone(value: string, country: string | null): string | null {
  const v = norm(value);
  // "Sydney NSW" or "Austin TX": the state can be the last word.
  const last = v.split(" ").pop()!;
  if (country === "CA") return CA_PROVINCES[v]?.[1] ?? CA_CODES[v] ?? CA_CODES[last] ?? null;
  if (country === "AU") return AU_STATES[v]?.[1] ?? AU_CODES[v] ?? AU_CODES[last] ?? null;
  if (country && country !== "US") return null;
  if (v === "dc" || v === "washington dc" || v === "washington district of columbia") return "America/New_York";
  const us = US_STATES[v]?.[1] ?? (/^[a-z]{2}$/.test(v) ? US_STATE_CODES[v] : undefined) ?? US_CITIES[v] ?? (last !== v ? US_STATE_CODES[last] : undefined);
  return us ?? (country ? null : (WORLD_CITIES[v] ?? null));
}

/** The timezone of a place written as "City, State, Country" (or any part of it). */
export function zoneForPlace(place: { location?: string | null; city?: string | null; state?: string | null; country?: string | null }): string | null {
  const parts = (place.location ?? "")
    .split(/[,|;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  // An explicit country field may be a code; in free text, two letters are more likely a US state ("Austin, TX").
  const country = (place.country && countryCode(place.country, true)) || (parts.length ? countryCode(parts[parts.length - 1]!, parts.length === 1) : null);
  if (country && COUNTRY_ZONES[country]) return COUNTRY_ZONES[country]!;
  const places = [place.state, place.city, ...parts.slice(0, country && !place.country ? -1 : undefined).reverse()].filter((p): p is string => !!p?.trim());
  for (const p of places) {
    const zone = regionZone(p, country);
    if (zone) return zone;
  }
  return null;
}

/** Country calling codes of countries with one timezone (or one most people live in). The US and Canada share +1. */
const CALLING_CODES: Record<string, string> = {
  "7": "RU",
  "20": "EG",
  "27": "ZA",
  "30": "GR",
  "31": "NL",
  "32": "BE",
  "33": "FR",
  "34": "ES",
  "36": "HU",
  "39": "IT",
  "40": "RO",
  "41": "CH",
  "43": "AT",
  "44": "GB",
  "45": "DK",
  "46": "SE",
  "47": "NO",
  "48": "PL",
  "49": "DE",
  "51": "PE",
  "52": "MX",
  "54": "AR",
  "55": "BR",
  "56": "CL",
  "57": "CO",
  "58": "VE",
  "60": "MY",
  "62": "ID",
  "63": "PH",
  "64": "NZ",
  "65": "SG",
  "66": "TH",
  "81": "JP",
  "82": "KR",
  "84": "VN",
  "86": "CN",
  "90": "TR",
  "91": "IN",
  "92": "PK",
  "94": "LK",
  "212": "MA",
  "233": "GH",
  "234": "NG",
  "254": "KE",
  "351": "PT",
  "352": "LU",
  "353": "IE",
  "354": "IS",
  "356": "MT",
  "357": "CY",
  "358": "FI",
  "359": "BG",
  "370": "LT",
  "371": "LV",
  "372": "EE",
  "380": "UA",
  "381": "RS",
  "385": "HR",
  "386": "SI",
  "420": "CZ",
  "421": "SK",
  "506": "CR",
  "507": "PA",
  "593": "EC",
  "598": "UY",
  "852": "HK",
  "880": "BD",
  "886": "TW",
  "965": "KW",
  "966": "SA",
  "968": "OM",
  "971": "AE",
  "972": "IL",
  "973": "BH",
  "974": "QA",
  "977": "NP",
};

/** The timezone of an international phone number's country ("+44 20 …", "0049 …"). */
export function zoneForPhone(phone: string | null | undefined): string | null {
  const p = (phone ?? "").trim();
  const intl = /^\+/.test(p) ? p.slice(1) : /^00/.test(p) ? p.slice(2) : null;
  if (intl === null) return null;
  const digits = intl.replace(/\D/g, "");
  for (const len of [3, 2, 1]) {
    const country = CALLING_CODES[digits.slice(0, len)];
    if (country) return COUNTRY_ZONES[country] ?? null;
  }
  return null;
}

/** Custom fields that may say where a lead is, by a loose match on their names. */
function field(payload: Record<string, unknown> | null | undefined, ...names: string[]): string | null {
  if (!payload) return null;
  for (const [k, v] of Object.entries(payload)) {
    const key = k.toLowerCase().replace(/[^a-z]/g, "");
    if (names.includes(key) && typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * A lead's timezone: the one given (or in a custom field called timezone), else from where they are (location, or
 * country, state and city fields), else from their phone number. Null when none of it says.
 */
export function inferLeadTimezone(lead: { timezone?: string | null; location?: string | null; phone?: string | null; payload?: Record<string, unknown> | null }): string | null {
  return (
    parseTimezone(lead.timezone) ??
    parseTimezone(field(lead.payload, "timezone", "tz", "timezonename")) ??
    zoneForPlace({
      location: lead.location ?? field(lead.payload, "location", "personlocation"),
      city: field(lead.payload, "city", "personcity"),
      state: field(lead.payload, "state", "region", "province", "personstate"),
      country: field(lead.payload, "country", "personcountry", "countrycode"),
    }) ??
    zoneForPhone(lead.phone ?? field(lead.payload, "phone", "phonenumber", "mobile", "mobilephone"))
  );
}

/** Every timezone the tables above can give, for checking they're all real. */
export const KNOWN_LEAD_ZONES = [
  ...new Set([
    ...Object.values(ABBREVIATIONS),
    ...Object.values(ODD_OFFSETS),
    ...Object.values(COUNTRY_ZONES),
    ...Object.values(US_STATES).map(([, z]) => z),
    ...Object.values(CA_PROVINCES).map(([, z]) => z),
    ...Object.values(AU_STATES).map(([, z]) => z),
    ...Object.values(US_CITIES),
    ...Object.values(WORLD_CITIES),
  ]),
];
