// Public holidays, worked out here rather than fetched: fixed dates, dates tied to Easter and "nth weekday" rules,
// plus the weekday people get off when a holiday falls on a weekend. National holidays only (no regional ones), for
// the countries below. Schedules use them for days off (CampaignSchedule.days_off).

export const HOLIDAY_COUNTRIES = {
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  IE: "Ireland",
  DE: "Germany",
  FR: "France",
  ES: "Spain",
  IT: "Italy",
  NL: "Netherlands",
} as const;
export type HolidayCountry = keyof typeof HOLIDAY_COUNTRIES;

export interface Holiday {
  /** YYYY-MM-DD, the day off (moved to a weekday where the country does that). */
  date: string;
  name: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
/** 0 Sunday … 6 Saturday. */
const weekday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** Easter Sunday (Gregorian), as [month, day]. */
export function easter(y: number): [number, number] {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

/** Days after Easter Sunday (negative: before). */
function fromEaster(y: number, days: number): string {
  const [m, d] = easter(y);
  return iso(y, m, d + days);
}

/** The nth weekday (0 Sunday … 6 Saturday) of a month; n = -1 for the last one. */
function nth(y: number, m: number, day: number, n: number): string {
  if (n > 0) {
    const first = weekday(y, m, 1);
    return iso(y, m, 1 + ((day - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDate = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = weekday(y, m, lastDate);
  return iso(y, m, lastDate - ((last - day + 7) % 7));
}

/** A fixed date, moved the US way when it falls on a weekend: Saturday to Friday, Sunday to Monday. */
function usObserved(y: number, m: number, d: number): string {
  const w = weekday(y, m, d);
  return iso(y, m, d + (w === 6 ? -1 : w === 0 ? 1 : 0));
}

/** A fixed date, moved to the next Monday when it falls on a weekend. */
function nextMonday(y: number, m: number, d: number): string {
  const w = weekday(y, m, d);
  return iso(y, m, d + (w === 6 ? 2 : w === 0 ? 1 : 0));
}

/** Christmas and the day after, with weekend substitutes on the following weekdays (UK, Canada, Australia, Ireland). */
function christmasPair(y: number, second: string): Holiday[] {
  const w = weekday(y, 12, 25);
  // Saturday: Monday 27 and Tuesday 28. Sunday: Monday 26 (the second day) and Tuesday 27. Friday: Monday 28.
  if (w === 6) return [{ date: iso(y, 12, 27), name: "Christmas Day (substitute)" }, { date: iso(y, 12, 28), name: `${second} (substitute)` }];
  if (w === 0) return [{ date: iso(y, 12, 26), name: second }, { date: iso(y, 12, 27), name: "Christmas Day (substitute)" }];
  if (w === 5) return [{ date: iso(y, 12, 25), name: "Christmas Day" }, { date: iso(y, 12, 28), name: `${second} (substitute)` }];
  return [{ date: iso(y, 12, 25), name: "Christmas Day" }, { date: iso(y, 12, 26), name: second }];
}

const RULES: Record<HolidayCountry, (y: number) => Holiday[]> = {
  US: (y) => [
    { date: usObserved(y, 1, 1), name: "New Year's Day" },
    { date: nth(y, 1, 1, 3), name: "Martin Luther King Jr. Day" },
    { date: nth(y, 2, 1, 3), name: "Presidents' Day" },
    { date: nth(y, 5, 1, -1), name: "Memorial Day" },
    { date: usObserved(y, 6, 19), name: "Juneteenth" },
    { date: usObserved(y, 7, 4), name: "Independence Day" },
    { date: nth(y, 9, 1, 1), name: "Labor Day" },
    { date: nth(y, 10, 1, 2), name: "Columbus Day" },
    { date: usObserved(y, 11, 11), name: "Veterans Day" },
    { date: nth(y, 11, 4, 4), name: "Thanksgiving" },
    { date: usObserved(y, 12, 25), name: "Christmas Day" },
  ],
  // England and Wales bank holidays.
  GB: (y) => [
    { date: nextMonday(y, 1, 1), name: "New Year's Day" },
    { date: fromEaster(y, -2), name: "Good Friday" },
    { date: fromEaster(y, 1), name: "Easter Monday" },
    { date: nth(y, 5, 1, 1), name: "Early May bank holiday" },
    { date: nth(y, 5, 1, -1), name: "Spring bank holiday" },
    { date: nth(y, 8, 1, -1), name: "Summer bank holiday" },
    ...christmasPair(y, "Boxing Day"),
  ],
  CA: (y) => [
    { date: nextMonday(y, 1, 1), name: "New Year's Day" },
    { date: fromEaster(y, -2), name: "Good Friday" },
    // The Monday before 25 May.
    { date: iso(y, 5, 24 - ((weekday(y, 5, 24) + 6) % 7)), name: "Victoria Day" },
    { date: weekday(y, 7, 1) === 0 ? iso(y, 7, 2) : iso(y, 7, 1), name: "Canada Day" },
    { date: nth(y, 9, 1, 1), name: "Labour Day" },
    { date: nth(y, 10, 1, 2), name: "Thanksgiving" },
    ...christmasPair(y, "Boxing Day"),
  ],
  // National holidays (states add their own).
  AU: (y) => [
    { date: nextMonday(y, 1, 1), name: "New Year's Day" },
    { date: nextMonday(y, 1, 26), name: "Australia Day" },
    { date: fromEaster(y, -2), name: "Good Friday" },
    { date: fromEaster(y, 1), name: "Easter Monday" },
    { date: iso(y, 4, 25), name: "Anzac Day" },
    { date: nth(y, 6, 1, 2), name: "King's Birthday" },
    ...christmasPair(y, "Boxing Day"),
  ],
  IE: (y) => [
    { date: iso(y, 1, 1), name: "New Year's Day" },
    // Since 2023: the first Monday in February, or 1 February when that's a Friday.
    ...(y >= 2023 ? [{ date: weekday(y, 2, 1) === 5 ? iso(y, 2, 1) : nth(y, 2, 1, 1), name: "St Brigid's Day" }] : []),
    { date: iso(y, 3, 17), name: "St Patrick's Day" },
    { date: fromEaster(y, 1), name: "Easter Monday" },
    { date: nth(y, 5, 1, 1), name: "May bank holiday" },
    { date: nth(y, 6, 1, 1), name: "June bank holiday" },
    { date: nth(y, 8, 1, 1), name: "August bank holiday" },
    { date: nth(y, 10, 1, -1), name: "October bank holiday" },
    ...christmasPair(y, "St Stephen's Day"),
  ],
  DE: (y) => [
    { date: iso(y, 1, 1), name: "Neujahr" },
    { date: fromEaster(y, -2), name: "Karfreitag" },
    { date: fromEaster(y, 1), name: "Ostermontag" },
    { date: iso(y, 5, 1), name: "Tag der Arbeit" },
    { date: fromEaster(y, 39), name: "Christi Himmelfahrt" },
    { date: fromEaster(y, 50), name: "Pfingstmontag" },
    { date: iso(y, 10, 3), name: "Tag der Deutschen Einheit" },
    { date: iso(y, 12, 25), name: "1. Weihnachtstag" },
    { date: iso(y, 12, 26), name: "2. Weihnachtstag" },
  ],
  FR: (y) => [
    { date: iso(y, 1, 1), name: "Jour de l'an" },
    { date: fromEaster(y, 1), name: "Lundi de Pâques" },
    { date: iso(y, 5, 1), name: "Fête du Travail" },
    { date: iso(y, 5, 8), name: "Victoire 1945" },
    { date: fromEaster(y, 39), name: "Ascension" },
    { date: fromEaster(y, 50), name: "Lundi de Pentecôte" },
    { date: iso(y, 7, 14), name: "Fête nationale" },
    { date: iso(y, 8, 15), name: "Assomption" },
    { date: iso(y, 11, 1), name: "Toussaint" },
    { date: iso(y, 11, 11), name: "Armistice 1918" },
    { date: iso(y, 12, 25), name: "Noël" },
  ],
  ES: (y) => [
    { date: iso(y, 1, 1), name: "Año Nuevo" },
    { date: iso(y, 1, 6), name: "Epifanía del Señor" },
    { date: fromEaster(y, -2), name: "Viernes Santo" },
    { date: iso(y, 5, 1), name: "Fiesta del Trabajo" },
    { date: iso(y, 8, 15), name: "Asunción de la Virgen" },
    { date: iso(y, 10, 12), name: "Fiesta Nacional de España" },
    { date: iso(y, 11, 1), name: "Todos los Santos" },
    { date: iso(y, 12, 6), name: "Día de la Constitución" },
    { date: iso(y, 12, 8), name: "Inmaculada Concepción" },
    { date: iso(y, 12, 25), name: "Navidad" },
  ],
  IT: (y) => [
    { date: iso(y, 1, 1), name: "Capodanno" },
    { date: iso(y, 1, 6), name: "Epifania" },
    { date: fromEaster(y, 1), name: "Lunedì dell'Angelo" },
    { date: iso(y, 4, 25), name: "Festa della Liberazione" },
    { date: iso(y, 5, 1), name: "Festa del Lavoro" },
    { date: iso(y, 6, 2), name: "Festa della Repubblica" },
    { date: iso(y, 8, 15), name: "Ferragosto" },
    { date: iso(y, 11, 1), name: "Ognissanti" },
    { date: iso(y, 12, 8), name: "Immacolata Concezione" },
    { date: iso(y, 12, 25), name: "Natale" },
    { date: iso(y, 12, 26), name: "Santo Stefano" },
  ],
  NL: (y) => [
    { date: iso(y, 1, 1), name: "Nieuwjaarsdag" },
    { date: fromEaster(y, 1), name: "Tweede Paasdag" },
    // King's Day moves to the 26th when the 27th is a Sunday.
    { date: weekday(y, 4, 27) === 0 ? iso(y, 4, 26) : iso(y, 4, 27), name: "Koningsdag" },
    { date: fromEaster(y, 39), name: "Hemelvaartsdag" },
    { date: fromEaster(y, 50), name: "Tweede Pinksterdag" },
    { date: iso(y, 12, 25), name: "Eerste Kerstdag" },
    { date: iso(y, 12, 26), name: "Tweede Kerstdag" },
  ],
};

export const isHolidayCountry = (code: string): code is HolidayCountry => Object.prototype.hasOwnProperty.call(HOLIDAY_COUNTRIES, code);

const cache = new Map<string, Holiday[]>();

/** A country's public holidays in a year, in date order. */
export function holidays(country: string, year: number): Holiday[] {
  if (!isHolidayCountry(country) || !Number.isInteger(year)) return [];
  const key = `${country}:${year}`;
  let list = cache.get(key);
  if (!list) {
    list = RULES[country](year).sort((a, b) => a.date.localeCompare(b.date));
    cache.set(key, list);
  }
  return list;
}

/** Days nothing goes out: public holidays of some countries, and dates of your own. */
export interface DaysOff {
  holidays?: string[];
  dates?: string[];
}

/** Why a date (YYYY-MM-DD) is a day off, or null when it isn't. */
export function dayOffReason(off: DaysOff | null | undefined, date: string): string | null {
  if (!off) return null;
  if (off.dates?.includes(date)) return "Day off";
  const year = Number(date.slice(0, 4));
  for (const c of off.holidays ?? []) {
    // A US New Year's Day on a Saturday is taken on 31 December, so look at next year's list too.
    const h = [...holidays(c, year), ...holidays(c, year + 1)].find((x) => x.date === date);
    if (h) return `${h.name} (${c})`;
  }
  return null;
}

/** The days off from one date (YYYY-MM-DD) on, in order, with every country's name for a shared day. */
export function upcomingDaysOff(off: DaysOff | null | undefined, from: string, limit = 5): Array<{ date: string; names: string[] }> {
  if (!off) return [];
  const year = Number(from.slice(0, 4));
  const byDate = new Map<string, string[]>();
  for (const d of off.dates ?? []) if (d >= from) byDate.set(d, [...(byDate.get(d) ?? []), "Day off"]);
  for (const c of off.holidays ?? []) {
    for (const h of [...holidays(c, year), ...holidays(c, year + 1)]) {
      if (h.date >= from) byDate.set(h.date, [...(byDate.get(h.date) ?? []), `${h.name} (${c})`]);
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, limit)
    .map(([date, names]) => ({ date, names }));
}
