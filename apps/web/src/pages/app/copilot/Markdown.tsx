// A small Markdown renderer for copilot answers: headings, paragraphs, lists, tables, quotes, code, links and
// emphasis. It builds React elements only (never raw HTML), and copes with half-written text while streaming.
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { ScrollX } from "@/components/ui/scroll-x";

type Node =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "rule" };

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function parse(src: string): Node[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Node[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^```/.test(line.trim())) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!.trim())) body.push(lines[i++]!);
      i++;
      out.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: "heading", level: h[1]!.length, text: h[2]!.replace(/\s#+$/, "") });
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push({ kind: "rule" });
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(splitRow(lines[i++]!));
      out.push({ kind: "table", head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[1]!);
      const start = ordered ? parseInt(li[1]!, 10) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (m && /\d/.test(m[1]!) === ordered) {
          items.push(m[2]!);
          i++;
        } else if (lines[i]!.trim() && /^\s{2,}\S/.test(lines[i]!) && items.length) {
          items[items.length - 1] += `\n${lines[i]!.trim()}`;
          i++;
        } else break;
      }
      out.push({ kind: "list", ordered, start, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!) && !(lines[i]!.trim().startsWith("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? ""))) {
      para.push(lines[i++]!);
    }
    out.push({ kind: "paragraph", text: para.join("\n") });
  }
  return out;
}

function safeHref(href: string): string | null {
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return href;
  if (href.startsWith("/")) return href;
  return null;
}

/** Inline formatting: `code`, **bold**, *italic* / _italic_, [links](url) and bare URLs. */
function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    const tok = m[0];
    if (m[1]) out.push(<code key={k} className="rounded bg-panel-2 px-1 py-0.5 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k} className="font-semibold">{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    else if (m[4]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const url = safeHref(href!);
      if (!url) out.push(label);
      else if (url.startsWith("/"))
        out.push(
          <Link key={k} to={url} className="font-medium text-brand-text underline-offset-2 hover:underline">
            {label}
          </Link>,
        );
      else
        out.push(
          <a key={k} href={url} target="_blank" rel="noreferrer noopener" className="font-medium text-brand-text underline-offset-2 hover:underline">
            {label}
          </a>,
        );
    } else
      out.push(
        <a key={k} href={tok} target="_blank" rel="noreferrer noopener" className="text-brand-text underline-offset-2 hover:underline">
          {tok}
        </a>,
      );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const withBreaks = (text: string, key: string) =>
  text.split("\n").map((l, i, all) => (
    <Fragment key={`${key}-${i}`}>
      {inline(l, `${key}-${i}`)}
      {i < all.length - 1 && <br />}
    </Fragment>
  ));

export function Markdown({ text, className }: { text: string; className?: string }) {
  const nodes = parse(text);
  return (
    <div className={cn("space-y-3 text-[14px] leading-relaxed", className)}>
      {nodes.map((n, i) => {
        const k = `b${i}`;
        switch (n.kind) {
          case "heading":
            return n.level <= 2 ? (
              <h3 key={k} className="pt-1 text-[15px] font-semibold">
                {inline(n.text, k)}
              </h3>
            ) : (
              <h4 key={k} className="pt-1 text-sm font-semibold">
                {inline(n.text, k)}
              </h4>
            );
          case "paragraph":
            return <p key={k}>{withBreaks(n.text, k)}</p>;
          case "list": {
            const Tag = n.ordered ? "ol" : "ul";
            return (
              <Tag key={k} start={n.ordered ? n.start : undefined} className={cn("space-y-1 pl-5", n.ordered ? "list-decimal" : "list-disc", "marker:text-faint")}>
                {n.items.map((it, j) => (
                  <li key={j} className="pl-0.5">
                    {withBreaks(it, `${k}-${j}`)}
                  </li>
                ))}
              </Tag>
            );
          }
          case "table":
            return (
              <ScrollX key={k} className="rounded-lg border border-line">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-panel-2 text-xs text-muted">
                    <tr>
                      {n.head.map((c, j) => (
                        <th key={j} className="whitespace-nowrap px-3 py-2 font-medium">
                          {inline(c, `${k}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {n.rows.map((r, j) => (
                      <tr key={j} className="border-t border-line">
                        {n.head.map((_, c) => (
                          <td key={c} className="px-3 py-2 align-top">
                            {inline(r[c] ?? "", `${k}-${j}-${c}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollX>
            );
          case "quote":
            return (
              <blockquote key={k} className="border-l-2 border-line-strong pl-3 text-muted">
                {withBreaks(n.text, k)}
              </blockquote>
            );
          case "code":
            return (
              <pre key={k} className="scroll-thin overflow-x-auto rounded-lg bg-panel-2 p-3 font-mono text-[12.5px] leading-snug">
                {n.text}
              </pre>
            );
          case "rule":
            return <hr key={k} className="border-line" />;
        }
      })}
    </div>
  );
}

/** Markdown reduced to plain text, for copying an answer. */
export function plainText(md: string): string {
  return md
    .replace(/```[a-z]*\n?/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^#{1,4}\s+/gm, "")
    .trim();
}
