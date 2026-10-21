// Template engine shared by the sequence editor preview and the sending engine.
//
// Syntax
//   {{firstName}}                    variable (exact key, nested path a.b[0].c, or case-insensitive)
//   {{firstName | there}}            variable with fallback when empty/unresolved
//   {{RANDOM | Hi | Hello | Hey}}    spintax: one option chosen per render (options may contain variables)
//   {{unsubscribe_url}}              system variables supplied by the caller

export type TemplateValue = string | number | boolean | null | undefined | TemplateObject | TemplateValue[];
export interface TemplateObject {
  [key: string]: TemplateValue;
}

export type TemplateWarningKind =
  | "unresolved"
  | "structured_leaf"
  | "ambiguous_flat_key"
  | "ambiguous_segment"
  | "array_index_required";

export interface TemplateWarning {
  kind: TemplateWarningKind;
  token: string;
}

export interface RenderOptions {
  /** HTML-escape inserted values (use for HTML bodies). */
  escapeHtml?: boolean;
  /** Random source in [0,1); defaults to Math.random. */
  random?: () => number;
  /** Leave unresolved tokens in place instead of rendering them empty. */
  keepUnresolved?: boolean;
}

export interface RenderResult {
  output: string;
  warnings: TemplateWarning[];
}

const SPINTAX_PREFIX = /^\s*random\s*\|/i;

/** Variables whose values are HTML already, so an HTML body takes them as they are (the signature comes from a rich-text editor). */
const HTML_VARIABLES = new Set(["accountsignature"]);
/** Attributes that hold an address: a value in one is written as part of a URL. */
const URL_ATTRIBUTES = new Set(["href", "src", "action", "background", "cite", "poster"]);

/**
 * Where an HTML template is up to, read from start to end: in text or inside a tag, and in which attribute's quoted
 * value (with that value's last character so far), so each {{variable}} is written the way its place needs.
 */
class HtmlCursor {
  inTag = false;
  quote = "";
  attr = "";
  last = "";
  private name = "";
  private naming = false;
  private afterEquals = "";
  advance(s: string) {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (!this.inTag) {
        if (ch === "<" && /[A-Za-z/!]/.test(s[i + 1] ?? "")) {
          this.inTag = true;
          this.name = "";
          this.naming = false;
          this.afterEquals = "";
        }
        continue;
      }
      if (this.quote) {
        if (ch === this.quote) {
          this.quote = "";
          this.attr = "";
        } else this.last = ch;
        continue;
      }
      if (ch === ">") {
        this.inTag = false;
        continue;
      }
      if (this.afterEquals) {
        if (ch === '"' || ch === "'") {
          this.quote = ch;
          this.attr = this.afterEquals;
          this.last = "";
          this.afterEquals = "";
          continue;
        }
        if (/\s/.test(ch)) continue;
        this.afterEquals = ""; // an unquoted value isn't followed
      }
      if (ch === "=") {
        this.afterEquals = this.name || " ";
        this.naming = false;
      } else if (/[\w:-]/.test(ch)) {
        if (!this.naming) this.name = "";
        this.naming = true;
        this.name += ch.toLowerCase();
      } else this.naming = false;
    }
  }
}

/** Characters a URL can't hold as they are (spaces, quotes, brackets, anything outside ASCII), percent-encoded. */
const encodeUrlText = (value: string) => value.replace(/[\s"'<>`^{}|\\]|[^\x00-\x7f]/gu, (c) => encodeURIComponent(c));

/** A name as written in an HTML body: "R&amp;D budget" is the variable "R&D budget". */
const plainName = (name: string) => decodeEntities(name).replace(/\u00a0/g, " ").trim();

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Returns null when braces are balanced, otherwise a human readable error. */
export function validateBraces(template: string): string | null {
  let depth = 0;
  for (let i = 0; i < template.length; i++) {
    if (template[i] === "{" && template[i + 1] === "{") {
      depth++;
      i++;
    } else if (template[i] === "}" && template[i + 1] === "}") {
      depth--;
      i++;
      if (depth < 0) return "Make sure all curly braces are properly opened and closed.";
    }
  }
  return depth === 0 ? null : "Make sure all curly braces are properly opened and closed.";
}

interface Token {
  start: number;
  end: number; // exclusive, after the closing braces
  inner: string;
}

/** Find top-level {{ ... }} tokens, honouring nesting (needed for spintax options containing variables). */
function findTokens(template: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < template.length; i++) {
    if (template[i] === "{" && template[i + 1] === "{") {
      if (depth === 0) start = i;
      depth++;
      i++;
    } else if (template[i] === "}" && template[i + 1] === "}" && depth > 0) {
      depth--;
      i++;
      if (depth === 0 && start >= 0) {
        tokens.push({ start, end: i + 1, inner: template.slice(start + 2, i - 1) });
        start = -1;
      }
    }
  }
  return tokens;
}

/** Split on '|' that are not nested inside {{ }}. */
function splitTopLevelPipes(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === "{{") {
      depth++;
      current += two;
      i++;
      continue;
    }
    if (two === "}}") {
      depth = Math.max(0, depth - 1);
      current += two;
      i++;
      continue;
    }
    if (text[i] === "|" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += text[i];
  }
  parts.push(current);
  return parts;
}

function parsePath(path: string): Array<string | number> | null {
  const segments: Array<string | number> = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) segments.push(m[1]);
    else segments.push(Number(m[2]));
    consumed += m[0].length;
  }
  const dots = (path.match(/\./g) || []).length;
  if (consumed + dots !== path.length) return null;
  return segments.length ? segments : null;
}

function isObject(v: unknown): v is Record<string, TemplateValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface Lookup {
  found: boolean;
  value: TemplateValue;
  warning?: TemplateWarningKind;
}

function lookup(vars: TemplateObject, rawKey: string): Lookup {
  const key = rawKey.trim();
  if (!key) return { found: false, value: undefined };
  const hasExact = Object.prototype.hasOwnProperty.call(vars, key);
  const segments = key.includes(".") || key.includes("[") ? parsePath(key) : null;

  let nested: Lookup | null = null;
  if (segments && segments.length > 1) {
    let node: TemplateValue = vars;
    let ok = true;
    let warning: TemplateWarningKind | undefined;
    for (const seg of segments) {
      if (typeof seg === "number") {
        if (!Array.isArray(node)) {
          ok = false;
          break;
        }
        node = node[seg];
      } else {
        if (!isObject(node)) {
          ok = false;
          break;
        }
        if (Object.prototype.hasOwnProperty.call(node, seg)) {
          node = node[seg];
        } else {
          const matches = Object.keys(node).filter((k) => k.toLowerCase() === seg.toLowerCase());
          if (matches.length === 0) {
            ok = false;
            break;
          }
          if (matches.length > 1) warning = "ambiguous_segment";
          node = node[matches[0]!];
        }
      }
    }
    if (ok) nested = { found: true, value: node, warning };
  }

  if (hasExact) {
    const value = vars[key];
    return { found: true, value, warning: nested ? "ambiguous_flat_key" : undefined };
  }
  if (nested) return nested;

  const ci = Object.keys(vars).filter((k) => k.toLowerCase() === key.toLowerCase());
  if (ci.length === 1) return { found: true, value: vars[ci[0]!] };
  if (ci.length > 1) return { found: true, value: vars[ci[0]!], warning: "ambiguous_segment" };
  return { found: false, value: undefined };
}

function stringify(value: TemplateValue): { text: string; warning?: TemplateWarningKind } {
  if (value === null || value === undefined) return { text: "" };
  if (Array.isArray(value)) return { text: "", warning: "array_index_required" };
  if (isObject(value)) return { text: "", warning: "structured_leaf" };
  return { text: String(value) };
}

export function renderTemplate(template: string, vars: TemplateObject, options: RenderOptions = {}): RenderResult {
  const warnings: TemplateWarning[] = [];
  const random = options.random ?? Math.random;
  // In an HTML body each value is written for its place: text (escaped, line breaks kept), an attribute (escaped),
  // or an address (escaped and percent-encoded; a query value fully).
  const html = options.escapeHtml ? new HtmlCursor() : null;
  const literal = (s: string) => {
    html?.advance(s);
    return s;
  };
  const insert = (value: string, name: string) => {
    if (!html) return value;
    let out: string;
    if (html.inTag) {
      const inUrl = !!html.quote && URL_ATTRIBUTES.has(html.attr);
      out = escapeHtml(inUrl ? (html.last === "=" ? encodeURIComponent(value) : encodeUrlText(html.last ? value : value.trim())) : value);
    } else out = HTML_VARIABLES.has(name.toLowerCase()) ? value : escapeHtml(value).replace(/\r\n?|\n/g, "<br>");
    html.advance(out);
    return out;
  };

  const renderInner = (text: string, depth: number): string => {
    if (depth > 8) return literal(text);
    const tokens = findTokens(text);
    if (!tokens.length) return literal(text);
    let out = "";
    let cursor = 0;
    for (const token of tokens) {
      out += literal(text.slice(cursor, token.start));
      cursor = token.end;
      const inner = token.inner;
      if (SPINTAX_PREFIX.test(inner)) {
        const options_ = splitTopLevelPipes(inner).slice(1);
        if (!options_.length) continue;
        const pick = options_[Math.min(options_.length - 1, Math.floor(random() * options_.length))]!;
        out += renderInner(pick.trim(), depth + 1);
        continue;
      }
      const [rawName, ...fallbackParts] = splitTopLevelPipes(inner);
      const name = plainName(rawName ?? "");
      const fallback = fallbackParts.length ? fallbackParts.join("|").trim() : null;
      const result = lookup(vars, name);
      const tokenText = `{{${name}}}`;
      if (!result.found) {
        if (fallback !== null) {
          out += renderInner(fallback, depth + 1);
        } else {
          warnings.push({ kind: "unresolved", token: tokenText });
          if (options.keepUnresolved) out += literal(text.slice(token.start, token.end));
        }
        continue;
      }
      if (result.warning) warnings.push({ kind: result.warning, token: tokenText });
      const { text: valueText, warning } = stringify(result.value);
      if (warning) warnings.push({ kind: warning, token: tokenText });
      // Only spaces is no value: the fallback stands in.
      if (!valueText.trim() && fallback !== null) {
        out += renderInner(fallback, depth + 1);
        continue;
      }
      out += insert(valueText, name);
    }
    out += literal(text.slice(cursor));
    return out;
  };

  return { output: renderInner(template, 0), warnings: dedupeWarnings(warnings) };
}

function dedupeWarnings(list: TemplateWarning[]): TemplateWarning[] {
  const seen = new Set<string>();
  return list.filter((w) => {
    const k = `${w.kind}:${w.token}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Variable names referenced by a template (spintax options are scanned too). */
export function extractVariables(template: string): string[] {
  const names = new Set<string>();
  const scan = (text: string, depth: number) => {
    if (depth > 8) return;
    for (const token of findTokens(text)) {
      if (SPINTAX_PREFIX.test(token.inner)) {
        for (const opt of splitTopLevelPipes(token.inner).slice(1)) scan(opt, depth + 1);
      } else {
        const name = plainName(splitTopLevelPipes(token.inner)[0] ?? "");
        if (name) names.add(name);
      }
    }
  };
  scan(template, 0);
  return [...names];
}

/**
 * The template with every `{{from}}` written as `{{to}}`, whatever its case: fallbacks stay, variables inside spintax
 * options and fallbacks are renamed too, and everything else is left exactly as it was.
 */
export function renameVariable(template: string, from: string, to: string, depth = 0): string {
  const target = from.trim().toLowerCase();
  if (!target || depth > 8 || !template.includes("{{")) return template;
  let out = "";
  let last = 0;
  for (const token of findTokens(template)) {
    out += template.slice(last, token.start);
    last = token.end;
    const [head = "", ...rest] = splitTopLevelPipes(token.inner);
    const options = rest.map((part) => renameVariable(part, from, to, depth + 1));
    if (SPINTAX_PREFIX.test(token.inner) || plainName(head).toLowerCase() !== target) {
      out += `{{${[head, ...options].join("|")}}}`;
      continue;
    }
    // The spaces around the name stay as they were written.
    const name = head.replace(head.trim(), () => to);
    out += `{{${[name, ...options].join("|")}}}`;
  }
  return out + template.slice(last);
}

/** One `{{variable}}` a template uses: its name and the text that stands in when it's empty (null without one). */
export interface VariableUse {
  name: string;
  fallback: string | null;
}

/**
 * The variables a template uses, including those inside spintax options (any option can be picked). Parse a
 * template once with this, then check many leads with {@link emptyVariables}.
 */
export function variableUses(template: string): VariableUse[] {
  const uses: VariableUse[] = [];
  const scan = (text: string, depth: number) => {
    if (depth > 8) return;
    for (const token of findTokens(text)) {
      if (SPINTAX_PREFIX.test(token.inner)) {
        for (const opt of splitTopLevelPipes(token.inner).slice(1)) scan(opt, depth + 1);
        continue;
      }
      const [rawName, ...fallbackParts] = splitTopLevelPipes(token.inner);
      const name = plainName(rawName ?? "");
      const fallback = fallbackParts.length ? fallbackParts.join("|").trim() : null;
      if (name && !uses.some((u) => u.name === name && u.fallback === fallback)) uses.push({ name, fallback });
    }
  };
  scan(template, 0);
  return uses;
}

/**
 * The `{{variables}}` that leave a gap for these values: no value (or only spaces) and no fallback. A fallback,
 * even an empty one (`{{title|}}`), counts as a choice and isn't reported.
 */
export function emptyVariables(uses: VariableUse[], vars: TemplateObject): string[] {
  const out: string[] = [];
  for (const u of uses) {
    if (u.fallback !== null) continue;
    const r = lookup(vars, u.name);
    if (r.found && stringify(r.value).text.trim()) continue;
    const token = `{{${u.name}}}`;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/** Standard lead variables (camelCase names used in templates). */
export const LEAD_VARIABLES = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "companyName", label: "Company name" },
  { key: "website", label: "Website" },
  { key: "phone", label: "Phone" },
  { key: "jobTitle", label: "Job title" },
  { key: "personalization", label: "Personalization" },
  { key: "companyDomain", label: "Company domain" },
] as const;

export const SENDER_VARIABLES = [
  { key: "sendingAccountFirstName", label: "Sender first name" },
  { key: "sendingAccountLastName", label: "Sender last name" },
  { key: "sendingAccountFullName", label: "Sender full name" },
  { key: "sendingAccountEmail", label: "Sender email" },
  { key: "accountSignature", label: "Signature" },
] as const;

export const SYSTEM_VARIABLES = [
  { key: "unsubscribe_url", label: "Unsubscribe URL" },
  { key: "today", label: "Today's date" },
  { key: "day_of_week", label: "Day of week" },
  { key: "time_of_day", label: "Time of day (morning / afternoon / evening)" },
] as const;

export interface LeadLike {
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  company_domain?: string | null;
  website?: string | null;
  phone?: string | null;
  job_title?: string | null;
  personalization?: string | null;
  linkedin_url?: string | null;
  location?: string | null;
  /** IANA timezone: the clock {{today}}, {{day_of_week}} and {{time_of_day}} go by for this lead. */
  timezone?: string | null;
  payload?: Record<string, unknown> | null;
}

export function leadVariables(lead: LeadLike): TemplateObject {
  const vars: TemplateObject = {
    email: lead.email ?? "",
    firstName: lead.first_name ?? "",
    lastName: lead.last_name ?? "",
    companyName: lead.company_name ?? "",
    companyDomain: lead.company_domain ?? "",
    website: lead.website ?? "",
    phone: lead.phone ?? "",
    jobTitle: lead.job_title ?? "",
    personalization: lead.personalization ?? "",
    linkedinUrl: lead.linkedin_url ?? "",
    location: lead.location ?? "",
  };
  for (const [k, v] of Object.entries(lead.payload ?? {})) {
    if (!(k in vars)) vars[k] = v as TemplateValue;
  }
  return vars;
}

export interface SenderLike {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  signature?: string | null;
}

export function senderVariables(sender: SenderLike): TemplateObject {
  const first = sender.first_name ?? "";
  const last = sender.last_name ?? "";
  return {
    sendingAccountFirstName: first,
    sendingAccountLastName: last,
    sendingAccountFullName: `${first} ${last}`.trim(),
    sendingAccountEmail: sender.email,
    accountSignature: sender.signature ?? "",
  };
}

/** The zone if this runtime knows it, else null. */
function knownZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/**
 * The variables for an email someone writes (a reply, a new email), as a campaign email has them: the lead's and the
 * sender's details, and the date and time on the lead's clock (else `zone`'s). {{unsubscribe_url}} asks by email.
 */
export function writtenEmailVariables(lead: LeadLike, sender: SenderLike, zone: string): TemplateObject {
  const unsubscribe = `mailto:${sender.email}?subject=unsubscribe`;
  return {
    ...leadVariables(lead),
    ...senderVariables(sender),
    ...timeVariables(new Date(), knownZone(lead.timezone) ?? knownZone(zone) ?? "UTC"),
    unsubscribe_url: unsubscribe,
    unsubscribeLink: unsubscribe,
  };
}

export function timeVariables(date: Date, timeZone: string): TemplateObject {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    hour: "numeric",
    hourCycle: "h23",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour"));
  return {
    today: `${get("month")} ${get("day")}, ${get("year")}`,
    day_of_week: get("weekday"),
    time_of_day: hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening",
  };
}

// Named character references: the Latin-1 letters and signs (U+00A0 to U+00FF, in order), the typographic ones and
// the basics. HTML knows many more; these cover what email editors and mail apps write.
const LATIN1_NAMES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";
const OTHER_NAMES: Record<string, number> = {
  amp: 38, AMP: 38, lt: 60, LT: 60, gt: 62, GT: 62, quot: 34, QUOT: 34, apos: 39,
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732,
  ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212,
  lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226,
  hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, euro: 8364, trade: 8482,
};
const NAMED_ENTITIES = new Map<string, string>([
  ...LATIN1_NAMES.split(" ").map((name, i): [string, string] => [name, String.fromCharCode(0xa0 + i)]),
  ...Object.entries(OTHER_NAMES).map(([name, code]): [string, string] => [name, String.fromCharCode(code)]),
]);

/**
 * HTML character references (&amp;, &#39;, &#x2019;, &eacute;…) turned into the characters they stand for, once:
 * "&amp;lt;" becomes "&lt;", not "<". A name it doesn't know, or one without its ";", stays as written.
 */
export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (ref, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES.get(name) ?? ref;
    const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    // As a browser reads them: nothing, half of a surrogate pair or past Unicode is the replacement character.
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\uFFFD" : String.fromCodePoint(code);
  });
}

/** Elements whose content is never shown as text. */
const HIDDEN_CONTENT = new Map(["script", "style", "title", "noscript", "template"].map((name) => [name, new RegExp(`<\\s*/\\s*${name}\\s*>`, "gi")]));
/** Paragraph-like elements: a blank line before and after. Line-like ones: a line of their own. */
const PARAGRAPH_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre"]);
const LINE_TAGS = new Set(["div", "li", "tr", "ul", "ol", "table", "section", "article", "header", "footer", "hr", "dl", "dt", "dd"]);

/** The end of the tag that opens at `from` (the index of its "<"): its ">", outside quoted attribute values; -1 if none. */
function tagEnd(html: string, from: number): number {
  let quote = "";
  let last = "";
  for (let i = from + 1; i < html.length; i++) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === ">") return i;
    // A quote opens a value only right after "=" (an apostrophe elsewhere is just a character).
    else if ((ch === '"' || ch === "'") && last === "=") quote = ch;
    if (!quote && !/\s/.test(ch)) last = ch;
  }
  return -1;
}

export interface HtmlToTextOptions {
  /** Links as [label](address), for text that's turned back into HTML afterwards (the default is "label (address)"). */
  markdownLinks?: boolean;
  /** What stands in for each image (given its tag); images leave nothing by default. */
  image?: (tag: string) => string;
}

/**
 * HTML → text, for text-only sends, the text part of every email, previews and snippets: paragraphs apart by a blank
 * line, lines and list items on lines of their own, links as "label (address)", and whitespace as a browser shows it.
 * One pass over the input, so its time grows with the input's length whatever the input is.
 */
export function htmlToText(html: string, opts: HtmlToTextOptions = {}): string {
  if (!html) return "";
  // Text with no tags at all (a body written as plain text) keeps its line breaks.
  const plain = !/<[A-Za-z!/?]/.test(html);
  const parts: string[] = [];
  /** Newlines at the end of what's written so far. */
  let newlines = 0;
  let pre = 0;
  const links: Array<{ href: string; at: number }> = [];
  const write = (s: string) => {
    if (!s) return;
    parts.push(s);
    const trailing = s.length - s.replace(/\n+$/, "").length;
    newlines = trailing === s.length ? newlines + trailing : trailing;
  };
  const text = (raw: string) => {
    if (pre || plain) return write(raw);
    let s = raw.replace(/[ \t\r\n\f]+/g, " ");
    if (!parts.length || newlines) s = s.replace(/^ /, "");
    write(s);
  };
  const breakBefore = (n: number) => {
    if (!parts.length) return;
    while (newlines < n) write("\n");
  };
  /** `i`: where the text not written yet starts; `scan`: where to look for the next tag. */
  let i = 0;
  let scan = 0;
  for (;;) {
    const lt = html.indexOf("<", scan);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    // "a < b": a "<" that doesn't open a tag is part of the text.
    if (!/[A-Za-z/!?]/.test(html[lt + 1] ?? "")) {
      scan = lt + 1;
      continue;
    }
    if (lt > i) text(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      if (close < 0) break;
      i = scan = close + 3;
      continue;
    }
    const gt = tagEnd(html, lt);
    if (gt < 0) break; // a tag cut off at the end shows nothing
    const tag = html.slice(lt + 1, gt);
    i = scan = gt + 1;
    const m = /^\s*(\/?)\s*([A-Za-z][A-Za-z0-9]*)/.exec(tag);
    if (!m) continue; // <!doctype>, <?xml?> and the like
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    const hidden = closing ? undefined : HIDDEN_CONTENT.get(name);
    if (hidden) {
      const re = hidden;
      re.lastIndex = i;
      const end = re.exec(html);
      if (!end) break;
      i = scan = end.index + end[0].length;
      continue;
    }
    if (name === "br") {
      write("\n");
    } else if (name === "a") {
      if (!closing) {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
        links.push({ href: (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim(), at: parts.length });
      } else {
        const link = links.pop();
        if (link && /^(https?:|mailto:|tel:)/i.test(link.href)) {
          const label = parts.splice(link.at).join("").trim();
          newlines = 0;
          if (opts.markdownLinks) write(`[${label.replace(/[[\]]/g, "") || link.href}](${link.href})`);
          else if (label && label !== link.href) write(`${label} (${link.href})`);
          else write(link.href);
        }
      }
    } else if (name === "img" && opts.image) {
      write(opts.image(`<${tag}>`));
    } else if (name === "li" && !closing) {
      breakBefore(1);
      write("• ");
    } else if (name === "td" || name === "th") {
      if (closing && !newlines) write(" ");
    } else if (PARAGRAPH_TAGS.has(name)) {
      breakBefore(2);
      if (name === "pre") pre = Math.max(0, pre + (closing ? -1 : 1));
    } else if (LINE_TAGS.has(name)) {
      breakBefore(1);
    }
  }
  // Decoded once ("&amp;lt;" is the text "&lt;"); non-breaking spaces are plain ones in text.
  const out = decodeEntities(parts.join("")).replace(/ /g, " ");
  return out
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain text → simple HTML (keeps line breaks). */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br/>");
}

export function snippet(htmlOrText: string, length = 140): string {
  const t = htmlToText(htmlOrText).replace(/\s+/g, " ").trim();
  return t.length > length ? `${t.slice(0, length - 1)}…` : t;
}
