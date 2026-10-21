// Leads as people paste them: an address with a name around it, one "Name" column instead of first and last.

/**
 * An email address inside other text (a name, angle brackets, "mailto:", a trailing dot), as a whole word: letters
 * outside a-z are part of it, so "jörg@…" is one address (which the syntax check refuses), never the "rg@…" in it.
 */
const EMAIL_IN_TEXT =
  /[\p{L}\p{N}\p{M}.!#$%&'*+\/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]*[\p{L}\p{N}\p{M}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]*[\p{L}\p{N}\p{M}])?)+/giu;

/**
 * The address in a cell as people write it: "jo@x.com", "Jo Doe <jo@x.com>", "mailto:jo@x.com", " JO@X.COM ". With
 * several, the first. A cell with none comes back trimmed and lowercased, for the usual syntax check to refuse.
 */
export function emailFromCell(value: string): string {
  const found = value.match(EMAIL_IN_TEXT);
  return (found?.[0] ?? value).trim().toLowerCase();
}

/** Every address in pasted text, lowercased, each once, in the order they appear. */
export function emailsIn(text: string): string[] {
  return [...new Set((text.match(EMAIL_IN_TEXT) ?? []).map((e) => e.toLowerCase()))];
}

/**
 * The people in pasted text, each address once in the order they appear, with the name written in front of an
 * address in angle brackets ("Jo Doe <jo@x.com>", as email apps copy it). Outlook separates people with semicolons,
 * so when there are any, commas are taken as part of names ("Doe, Jo <jo@x.com>").
 */
export function peopleIn(text: string): Array<{ email: string; first_name?: string; last_name?: string }> {
  const out = new Map<string, { email: string; first_name?: string; last_name?: string }>();
  for (const part of text.split(text.includes(";") ? /[;\n]/ : /[,;\n]/)) {
    let from = 0;
    for (const m of part.matchAll(EMAIL_IN_TEXT)) {
      const before = part.slice(from, m.index).replace(/^[\s>]+/, "");
      from = m.index + m[0].length;
      const email = m[0].toLowerCase();
      if (out.has(email)) continue;
      const written = /<\s*$/.test(before) ? before.replace(/<\s*$/, "").replace(/^["'\s]+|["'\s]+$/g, "") : "";
      const name = written && !written.includes("@") ? splitFullName(written) : null;
      out.set(email, name?.first_name ? { email, ...name } : { email });
    }
  }
  return [...out.values()];
}

const TITLES = /^(mr|mrs|ms|mx|miss|dr|prof)\.?$/i;
const SUFFIXES = /^(jr|sr|ii|iii|iv|phd|md|mba|esq)\.?$/i;

/** First and last name from one cell: "Jo Doe", "Doe, Jo", "Dr. Jo van Doe", "Jo Doe, PhD". */
export function splitFullName(value: string): { first_name: string; last_name: string } {
  let s = value.replace(/\s+/g, " ").trim();
  const comma = s.indexOf(",");
  if (comma > 0) {
    const after = s.slice(comma + 1).trim();
    // "Doe, Jo" is last name first; "Jo Doe, PhD" is a name with a suffix.
    if (after && !SUFFIXES.test(after)) return { first_name: after, last_name: s.slice(0, comma).trim() };
    s = s.slice(0, comma).trim();
  }
  const words = s.split(" ").filter((w) => w && !TITLES.test(w));
  return { first_name: words[0] ?? "", last_name: words.slice(1).join(" ") };
}
