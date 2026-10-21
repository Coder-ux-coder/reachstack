// What a person actually wrote in a reply, and what it asks for: the newest text without quoted history or
// signatures, opt-out requests ("stop", "remove me", a List-Unsubscribe mailto) and out-of-office notices with
// the date the person is back. Pure functions: no database, no network.
import { DateTime } from "luxon";
import { isValidZone } from "../lib/time";

// ---------- Newest text ----------

/** "On Tue, … wrote:" and its translations; Gmail puts a date (digits) in it, which rules out ordinary sentences. */
const ATTRIBUTION = /^(On|Am|Le|El|Op|Il|Em)\s.{3,300}(wrote|schrieb|a écrit|escribió|schreef|ha scritto|escreveu)( .{0,80})?\s?:$/i;
const QUOTE_HEADERS = [
  /^-{2,}\s*(original message|ursprüngliche nachricht|message d'origine|mensaje original|oorspronkelijk bericht|messaggio originale|forwarded message|weitergeleitete nachricht)\s*-{2,}$/i,
  /^(begin forwarded message|anfang der weitergeleiteten nachricht)\s?:$/i,
  /^_{8,}$/, // Outlook's line above the quoted message
  /^\*?From:\*?\s.+\s\*?(Sent|Date):\*?\s/i, // Outlook on the web: the whole header on one line
];
const HEADER_FROM = /^\*?(From|Von|De|Da|Van)\s?:\*?\s/i;
const HEADER_NEXT = /^\*?(Sent|Date|To|Subject|Gesendet|Datum|An|Betreff|Envoyé|À|Objet|Enviado|Fecha|Para|Asunto|Verzonden|Aan|Onderwerp|Inviato|Oggetto)\s?:\*?/i;
const SIGNATURE = [
  /^--\s?$/,
  /^Sent from my (iPhone|iPad|Android|BlackBerry|mobile|phone|Galaxy|Samsung|Pixel)/i,
  /^Sent from (Mail|Outlook|Yahoo Mail|Proton ?Mail|AOL Mail|Gmail)\b/i,
  /^Get Outlook for (iOS|Android)/i,
  /^Von meinem .{0,40}gesendet/i,
  /^Envoyé de mon/i,
  /^Enviado desde mi/i,
];

function quoteStartsAt(lines: string[], i: number): boolean {
  const t = lines[i]!.trim();
  if (!t) return false;
  if (QUOTE_HEADERS.some((re) => re.test(t))) return true;
  if (/\d/.test(t) && ATTRIBUTION.test(t)) return true;
  // Gmail wraps a long attribution onto a second line ("… <sam@example.com>" / "wrote:").
  if (/^(On|Am|Le|El|Op|Il|Em)\s/.test(t) && i + 1 < lines.length) {
    const joined = `${t} ${lines[i + 1]!.trim()}`;
    if (/\d/.test(joined) && ATTRIBUTION.test(joined)) return true;
  }
  // Outlook's header block: "From: …" followed by "Sent:", "To:" or "Subject:".
  if (HEADER_FROM.test(t)) {
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) if (HEADER_NEXT.test(lines[j]!.trim())) return true;
  }
  return false;
}

const isSignature = (t: string) => SIGNATURE.some((re) => re.test(t));
const tidy = (lines: string[]) =>
  lines
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Only what the person wrote this time: no quoted history ("On … wrote:", "> …", Outlook headers, forwards) and no
 * signature after "--" or a "Sent from my phone" line. Empty when the message holds nothing new.
 */
export function newestReplyText(text: string | null | undefined): string {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (quoteStartsAt(lines, i) || isSignature(t)) break;
    if (t.startsWith(">")) continue;
    kept.push(lines[i]!);
  }
  const top = tidy(kept);
  if (top || i >= lines.length) return top;
  // Bottom-posted: nothing above the quote, so the person wrote below or between the ">" lines.
  const rest = lines.slice(i + 1);
  if (!rest.some((l) => l.trim().startsWith(">"))) return "";
  const below: string[] = [];
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j]!.trim();
    if (isSignature(t) || quoteStartsAt(rest, j)) break;
    if (!t.startsWith(">")) below.push(rest[j]!);
  }
  return tidy(below);
}

/** Whether a message quotes an earlier one ("On … wrote:", Outlook's header block, "> " lines), as people's replies do. */
export function quotesEarlier(text: string | null | undefined): boolean {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  return lines.some((line, i) => line.trim().startsWith(">") || quoteStartsAt(lines, i));
}

/** A reply's subject that just repeats ours ("Re: …", "AW: …"); a fresh subject is the person's own words. */
export const isReplySubject = (subject: string) => /^\s*(re|aw|sv|vs|antw|rif|r|odp|ref|res|tr|fw|fwd|wg)\s*(\[\d+\])?\s*:/i.test(subject);

/**
 * The words of a reply that its sender wrote: a fresh subject (not "Re: <our subject>") and the newest text. Takes a
 * reply_received event's data, which carries the newest text as `latest_text`.
 */
export function replyWords(data: { subject?: unknown; text?: unknown; latest_text?: unknown }): string {
  const subject = typeof data.subject === "string" ? data.subject.trim() : "";
  const newest = typeof data.latest_text === "string" ? data.latest_text : newestReplyText(typeof data.text === "string" ? data.text : "");
  return `${subject && !isReplySubject(subject) ? `${subject}\n` : ""}${newest}`;
}

// ---------- Opt-outs ----------

/** Subjects a mail app puts into a List-Unsubscribe mailto, or a person writes on a fresh email. */
const UNSUBSCRIBE_SUBJECT = /^\s*(unsubscribe( me)?|remove( me)?|opt[ -]?out|stop|abmelden|austragen|désabonnement|désinscription|desinscription|darse de baja|baja|afmelden|cancella(mi)?)[\s.!]*$/i;
/** What those mail apps write in the body, if anything. */
const GENERATED_BODY = /^(this (message|e-?mail) was (automatically )?(generated|sent)\b[^\n]{0,120}|unsubscribe( me)?[.!]?|please unsubscribe( me)?[.!]?)?$/i;

/** Whole short messages that only say "stop" or "unsubscribe". */
const SHORT_STOP = /^(please )?(stop|unsubscribe|unsub|remove|remove me|opt[ -]?out|end|quit|no more( emails)?|leave me alone|stop emailing( me)?|stop it)( please)?[\s.!]*$/i;
/** Opt-out wording anywhere in the newest text. */
const OPT_OUT: RegExp[] = [
  /\bunsubscribe (me|us)\b/i,
  /\bplease unsubscribe\b/i,
  /\b(i|we)('d| would| want| wish| need)( like)? to (be )?unsubscribe/i,
  /\b(remove|delete|take|drop) (me|us|my (e-?mail|address|details|contact details|info(rmation)?)|this (e-?mail|address))( address)? (off|from) (your|the|this|all|any|our)( [\w-]+){0,3} (list|lists|database|distribution|emails?|e-?mails|mailings?|campaigns?|sequences?|outreach|system|crm|contacts)\b/i,
  /\btake (me|us) off\b/i,
  /\bremove me\b(?!,? (from|off) (the )?(cc|thread|chain|loop|copy|invite|meeting|call))/i,
  /\bstop (e-?mailing|contacting|messaging|spamming|writing to|sending (me|us|these|this|emails|e-?mails))\b/i,
  /\b(do not|don'?t|never|please don'?t) (contact|e-?mail|message|write to|reach out to) (me|us)\b/i,
  /\bopt (me |us )?out\b/i,
  /\bno (more|further) (e-?mails|messages|contact)\b/i,
  /\bput (me|us) on (your|the) do[- ]not[- ](contact|e-?mail|mail)/i,
  /\b(bitte )?(austragen|abmelden)\b|\bentfernen sie (mich|meine)\b|\bnehmen sie mich (aus|von)\b|\bkeine (weiteren )?(e-?mails|nachrichten)\b/i,
  /désabonner|désinscri(re|vez|ption)|\bretirez[- ]moi\b|\bne (plus )?me (contactez|écrivez) plus\b|\bne plus me contacter\b/i,
  /\bdar(me)? de baja\b|\bno me (escriba|escriban|contacte|contacten|envíe|envíen) (más|mas)\b|\bquitarme de\b/i,
  /\bafmelden\b|\bverwijder (mij|me)\b/i,
  /\bcancellami\b|\bdisiscri(vi|vermi|zione)\b|\bnon (contattatemi|scrivetemi) più\b/i,
];
/** "Please don't unsubscribe me", "no need to remove me": the wording is there but the wish isn't. */
const NEGATED = /\b(don'?t|do not|never|no need to|not)\s+(\w+\s+)?$/i;

/**
 * Whether a message asks to stop the emails. "request": a bare unsubscribe email (a List-Unsubscribe mailto or a
 * fresh "Unsubscribe" email with nothing else in it), which isn't a conversation; "reply": a reply that asks to stop.
 */
export function detectOptOut(subject: string, newest: string): "request" | "reply" | null {
  const body = newest.trim();
  if (UNSUBSCRIBE_SUBJECT.test(subject)) return GENERATED_BODY.test(body.replace(/\s+/g, " ")) ? "request" : "reply";
  if (!body) return null;
  if (body.length <= 160 && body.split("\n").some((l) => SHORT_STOP.test(l.trim()))) return "reply";
  for (const re of OPT_OUT) {
    const m = re.exec(body);
    if (!m) continue;
    const before = body.slice(Math.max(0, m.index - 30), m.index);
    // Phrases that are already negative ("do not contact me") can't be negated again this way.
    if (!/^(do not|don'?t|never|please don'?t)/i.test(m[0]) && NEGATED.test(before)) continue;
    return "reply";
  }
  return null;
}

// ---------- Out of office ----------

const ABSENCE = new RegExp(
  [
    "out of (the )?office",
    "\\booo\\b",
    "\\bon (annual |parental |maternity |paternity |sick |medical |study |family |bereavement )?leave\\b",
    "\\bon (vacation|holiday|holidays|sabbatical|pto|annual leave)\\b",
    "\\b(vacation|holiday|leave) (until|till|through|from)\\b",
    "\\baway (from (the |my )?(office|desk)|for|until|till|through|on (business|vacation|holiday))\\b",
    "\\bcurrently (away|out|travel+ing|on leave)\\b",
    "\\b(i'?m|i am|i will be|i'?ll be) (off|offline|unavailable|not available|travel+ing)\\b",
    "\\b(limited|sporadic|intermittent|restricted|no) access to (my )?e-?mails?\\b",
    "\\b(back|return(ing)?) (in|to) the office\\b",
    "\\b(i will be|i'?ll be|i am|i'?m|will be) (back|returning)\\b(?! to you| in touch| with you)",
    "abwesen|nicht im (büro|haus)|\\bim urlaub\\b",
    "\\babsent\\b|\\ben congé\\b|\\ben vacances\\b|hors du bureau",
    "fuera de la oficina|\\bde vacaciones\\b|\\bausente\\b",
    "\\bafwezig\\b|\\bmet vakantie\\b",
    "fuori ufficio|\\bin ferie\\b|\\bassente\\b",
  ].join("|"),
  "i",
);

/** An automatic reply that says the person is away (rather than "we got your message"). */
export function isAbsenceNotice(subject: string, text: string): boolean {
  return ABSENCE.test(subject) || ABSENCE.test(text.slice(0, 3_000));
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  januar: 1, jänner: 1, februar: 2, märz: 3, maerz: 3, mai: 5, juni: 6, juli: 7, oktober: 10, okt: 10, dezember: 12, dez: 12,
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, juin: 6, juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  januari: 1, februari: 2, maart: 3, mei: 5, augustus: 8,
  gennaio: 1, febbraio: 2, aprile: 4, maggio: 5, giugno: 6, luglio: 7, settembre: 9, ottobre: 10, dicembre: 12,
};
const WEEKDAYS: Record<string, number> = {
  monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7,
  montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonntag: 7,
  lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6, dimanche: 7,
  lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6, domingo: 7,
  maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6, zondag: 7,
};
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, "a couple of": 2, "a few": 3 };

const alt = (words: string[]) => words.sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const LB = "(?<![\\p{L}\\d])";
const RB = "(?![\\p{L}\\d])";
const MONTH = `(${alt(Object.keys(MONTHS))})\\.?`;
const ORDINAL = "(?:st|nd|rd|th|er|e|ème|º)?";
/** "21 October", "21st of Oct 2026", "21. Oktober", "21 de octubre de 2026" */
const DAY_MONTH = new RegExp(`${LB}(\\d{1,2})${ORDINAL}\\.?(?:\\s+(?:of|de|del))?\\s+${MONTH}${RB}(?:,?\\s+(?:de\\s+)?(\\d{4}))?`, "giu");
/** "October 21", "Oct 21st, 2026" */
const MONTH_DAY = new RegExp(`${LB}${MONTH}\\s+(\\d{1,2})${ORDINAL}${RB}(?:,?\\s+(\\d{4}))?`, "giu");
/** 2026-10-21 */
const ISO_DATE = /(?<!\d)(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g;
/** 21/10/2026, 21.10.26, 10-21-2026, and without a year 21/10 or 21.10. (not times like 10.30am) */
const NUMERIC = /(?<![\d/.:,-])(\d{1,2})([/.-])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?![\d/:]|[.,]\d)/g;
const WEEKDAY = new RegExp(`${LB}(?:(next|this|coming)\\s+)?(${alt(Object.keys(WEEKDAYS))})\\.?${RB}`, "giu");
const RELATIVE = /(?<![\p{L}])(later today|today|tonight|this (afternoon|evening)|day after tomorrow|tomorrow|next week|end of (the |this )?week|after the weekend|next month|end of (the |this )?month|heute|demain|domani)(?![\p{L}])/giu;
const DURATION = new RegExp(
  `${LB}(?:for|in|within|für|pendant|durante|per)\\s+(\\d{1,2}|${alt(Object.keys(NUMBER_WORDS))})\\s+(days?|weeks?|months?|tagen?|wochen?|jours?|semaines?|días?|semanas?)${RB}`,
  "giu",
);
const ANCHOR =
  /(?<![\p{L}])(back|return|returning|returns|resume|resuming|until|till|til|through|thru|up to and including|available (again )?(from|on)|reachable (again )?(from|on)|in the office (on|from)|bis( zum| einschließlich| inkl\.?)?|zurück|wieder (da|im büro|erreichbar)|ab dem|de retour|retour|jusqu['’](au|à)|hasta|regreso|regresaré|vuelvo|terug|tot en met|fino al|rientro|di ritorno)(?![\p{L}])/giu;

/** "until the 22nd": a day of the month on its own (this month, or next month once it has passed). */
const DAY_ONLY = new RegExp(`${LB}the\\s+(\\d{1,2})(?:st|nd|rd|th)${RB}`, "giu");

interface Found {
  start: number;
  end: number;
  date: DateTime;
  /** written: a date with its month ("21 October", "21/10"); vague: a weekday, "tomorrow", "the 22nd"; duration: "for two weeks". */
  kind: "written" | "vague" | "duration";
}

/** Day and month without a year: the next time that date comes round (a date over a week past means next year). */
function nextOccurrence(month: number, day: number, ref: DateTime): DateTime | null {
  let d = DateTime.fromObject({ year: ref.year, month, day }, { zone: ref.zone });
  if (!d.isValid) return null;
  if (d < ref.minus({ days: 7 })) d = d.plus({ years: 1 });
  return d.isValid ? d : null;
}

function datesIn(text: string, ref: DateTime): Found[] {
  const out: Found[] = [];
  const add = (m: RegExpMatchArray, date: DateTime | null, kind: Found["kind"]) => {
    const start = m.index!;
    const end = start + m[0].length;
    if (!date?.isValid || out.some((f) => start < f.end && end > f.start)) return;
    out.push({ start, end, date: date.startOf("day"), kind });
  };
  const day = ref.startOf("day");
  const year = (y: string | undefined) => (y ? Number(y.length === 2 ? `20${y}` : y) : null);
  const ymd = (y: number | null, month: number, d: number) => (y ? DateTime.fromObject({ year: y, month, day: d }, { zone: ref.zone }) : nextOccurrence(month, d, ref));
  for (const m of text.matchAll(ISO_DATE)) add(m, ymd(+m[1]!, +m[2]!, +m[3]!), "written");
  for (const m of text.matchAll(DAY_MONTH)) add(m, ymd(year(m[3]), MONTHS[m[2]!.toLowerCase()]!, +m[1]!), "written");
  for (const m of text.matchAll(MONTH_DAY)) add(m, ymd(year(m[3]), MONTHS[m[1]!.toLowerCase()]!, +m[2]!), "written");
  for (const m of text.matchAll(NUMERIC)) {
    const [a, sep, b, y] = [+m[1]!, m[2]!, +m[3]!, year(m[4])];
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 6);
    const before = text.slice(Math.max(0, m.index! - 4), m.index!);
    // Times ("at 10.30", "9.15am") and ranges ("3-5 days") aren't dates.
    if (/^\s?(am|pm|a\.m|p\.m|h\b|hrs|uhr|o'clock)/i.test(after) || /\b(at|um|à)\s$/i.test(before) || (sep === "-" && !y)) continue;
    // Day first (most of the world) or month first (US): whichever reading is valid, nearest in the future.
    const readings = [
      [a, b],
      [b, a],
    ]
      .map(([d, month]) => (month! <= 12 ? ymd(y, month!, d!) : null))
      .filter((d): d is DateTime => !!d?.isValid)
      .sort((x, z) => Math.abs(x.diff(ref).toMillis()) - Math.abs(z.diff(ref).toMillis()));
    add(m, readings.find((d) => d >= day) ?? readings[0] ?? null, "written");
  }
  for (const m of text.matchAll(WEEKDAY)) {
    // "Monday, 20 October": the written date says it already.
    const end = m.index! + m[0].length;
    if (out.some((f) => f.kind === "written" && f.start >= end && f.start - end <= 3)) continue;
    const wd = WEEKDAYS[m[2]!.toLowerCase()]!;
    let d = day.plus({ days: 1 });
    while (d.weekday !== wd) d = d.plus({ days: 1 });
    add(m, d, "vague");
  }
  for (const m of text.matchAll(DAY_ONLY)) {
    const n = +m[1]!;
    const thisMonth = day.set({ day: n });
    add(m, thisMonth.isValid && thisMonth.day === n && thisMonth >= day ? thisMonth : day.plus({ months: 1 }).set({ day: n }), "vague");
  }
  for (const m of text.matchAll(RELATIVE)) {
    const w = m[1]!.toLowerCase();
    let d: DateTime;
    if (/today|tonight|this|heute/.test(w)) d = day;
    else if (w === "day after tomorrow") d = day.plus({ days: 2 });
    else if (/tomorrow|demain|domani/.test(w)) d = day.plus({ days: 1 });
    else if (w === "next week" || w === "after the weekend") d = day.plus({ weeks: 1 }).startOf("week");
    else if (/end of .*week/.test(w)) d = day.weekday <= 5 ? day.set({ weekday: 5 }) : day.plus({ weeks: 1 }).set({ weekday: 5 });
    else if (w === "next month") d = day.plus({ months: 1 }).startOf("month");
    else d = day.endOf("month");
    add(m, d, "vague");
  }
  for (const m of text.matchAll(DURATION)) {
    const n = /^\d+$/.test(m[1]!) ? +m[1]! : (NUMBER_WORDS[m[1]!.toLowerCase()] ?? 1);
    const unit = m[2]!.toLowerCase();
    add(m, day.plus(/^(week|woche|semaine|semana)/.test(unit) ? { weeks: n } : /^month/.test(unit) ? { months: n } : { days: n }), "duration");
  }
  return out;
}

/**
 * The date an out-of-office notice says the person is back (ISO yyyy-mm-dd), or null when it gives none. Reads
 * "back on 21 October", "returning Monday", "until 2026-10-21", "bis 21.10.", "for two weeks"… Dates right after
 * "back", "until", "returning" and the like win; then the latest written date; then a weekday or "tomorrow".
 * Relative words count from when the notice was sent, in the given time zone.
 */
export function parseReturnDate(text: string, sentAt: Date, tz = "UTC"): string | null {
  const zone = isValidZone(tz) ? tz : "UTC";
  const ref = DateTime.fromJSDate(sentAt).setZone(zone);
  const body = text.slice(0, 4_000);
  const found = datesIn(body, ref).filter((f) => f.date >= ref.startOf("day") && f.date <= ref.plus({ days: 365 }));
  const anchors = [...body.matchAll(ANCHOR)].map((m) => m.index! + m[0].length);
  // Close behind the anchor word, in the same sentence.
  const anchored = (f: Found) => anchors.some((end) => end <= f.start && f.start - end <= 40 && !/[\n!?]|\.\s+\p{Lu}/u.test(body.slice(end, f.start)));
  const tiers = [found.filter((f) => f.kind === "duration" || anchored(f)), found.filter((f) => f.kind === "written"), found];
  for (const tier of tiers) {
    if (tier.length) return tier.reduce((a, b) => (b.date > a.date ? b : a)).date.toISODate();
  }
  return null;
}

/** An out-of-office pause: when the next email may go once the person is back. */
export const ABSENCE_PAUSE = { defaultDays: 7, maxDays: 30 } as const;

/** The start of the day after the return date (in the campaign's time zone), at most 30 days away; a week when no date is given. */
export function resumeAfterAbsence(returnDate: string | null, now: Date, tz = "UTC"): Date {
  const zone = isValidZone(tz) ? tz : "UTC";
  const local = DateTime.fromJSDate(now).setZone(zone);
  const cap = local.plus({ days: ABSENCE_PAUSE.maxDays });
  if (returnDate) {
    const d = DateTime.fromISO(returnDate, { zone }).plus({ days: 1 }).startOf("day");
    if (d.isValid && d > local) return (d < cap ? d : cap).toJSDate();
  }
  return local.plus({ days: ABSENCE_PAUSE.defaultDays }).startOf("day").toJSDate();
}
