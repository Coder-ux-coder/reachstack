// Outbound request guard: user-supplied URLs (webhooks, feeds) must not reach private networks in production.
import dns from "node:dns";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { config } from "../env";
import { badRequest } from "../http/errors";

/** The 8 hextets of an IPv6 address (with "::" expanded and a trailing dotted IPv4 folded in), or null. */
function ipv6Hextets(ip: string): number[] | null {
  let v = ip.toLowerCase().split("%")[0]!;
  const dotted = v.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[2]!.split(".").map(Number) as [number, number, number, number];
    v = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array<string>(fill).fill("0"), ...tail].map((h) => parseInt(h, 16));
  return parts.length === 8 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? parts : null;
}

const ipv4FromHextets = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * Loopback, private, link-local, carrier-grade NAT, multicast and reserved addresses. IPv6 forms that carry an IPv4
 * address (mapped `::ffff:a.b.c.d` in dotted or hex form, compatible, NAT64, 6to4) are judged by that address.
 */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const h = ipv6Hextets(ip);
    if (!h) return true;
    const zeros = (n: number) => h.slice(0, n).every((x) => x === 0);
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, which also covers :: and ::1).
    if (zeros(5) && (h[5] === 0xffff || h[5] === 0)) return h[6] === 0 && h[7]! <= 1 ? true : isPrivateIp(ipv4FromHextets(h[6]!, h[7]!));
    // NAT64 64:ff9b::/96 and 6to4 2002::/16 reach an IPv4 address.
    if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isPrivateIp(ipv4FromHextets(h[6]!, h[7]!));
    if (h[0] === 0x2002) return isPrivateIp(ipv4FromHextets(h[1]!, h[2]!));
    const first = h[0]!;
    return (
      (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
      (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
      (first & 0xffc0) === 0xfec0 || // old site-local fec0::/10
      (first & 0xff00) === 0xff00 || // multicast ff00::/8
      (first === 0x2001 && h[1] === 0) || // Teredo 2001::/32
      (first === 0x100 && h[1] === 0 && h[2] === 0 && h[3] === 0) // discard 100::/64
    );
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Throws unless a mail server's host resolves only to public addresses (or private addresses are allowed). */
export async function assertPublicHost(rawHost: string, what: string): Promise<void> {
  if (config.allowPrivateUrls) return;
  const host = rawHost.trim().replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw badRequest(`${what}: the host name could not be found`);
  if (addrs.some((a) => isPrivateIp(a.address))) throw badRequest(`${what} is on a private or internal network, which isn't allowed here`);
}

/** Throws unless `raw` is an http(s) URL whose host resolves only to public addresses (or private URLs are allowed). */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest("Enter a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("Only http and https URLs are allowed");
  if (config.allowPrivateUrls) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw badRequest("The URL's host could not be resolved");
  if (addrs.some((a) => isPrivateIp(a.address))) throw badRequest("URLs pointing to private or internal networks are not allowed");
  return url;
}

/**
 * The name lookup for requests to user-supplied URLs, made as the connection is: a name that gives a public address to
 * the check and a private one to the request (DNS rebinding) is refused all the same.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    if (!config.allowPrivateUrls && addresses.some((a) => isPrivateIp(a.address))) {
      return callback(Object.assign(new Error(`${hostname} is on a private or internal network`), { code: "EPRIVATE" }), "", 0);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]?.address ?? "", addresses[0]?.family ?? 4);
  });
};

export interface OutboundInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  signal?: AbortSignal;
}

// Connections aren't kept for reuse: each request is looked up, and checked, again.
const agents = { http: new http.Agent({ keepAlive: false }), https: new https.Agent({ keepAlive: false }) };

/** One request over node:http(s) with publicLookup, answered as fetch would answer it. Redirects aren't followed. */
function send(raw: string, init: OutboundInit): Promise<Response> {
  const url = new URL(raw);
  const secure = url.protocol === "https:";
  return new Promise<Response>((resolve, reject) => {
    const req = (secure ? https : http).request(url, { method: init.method ?? "GET", headers: init.headers, signal: init.signal, lookup: publicLookup, agent: secure ? agents.https : agents.http }, (res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, v);
      const status = res.statusCode && res.statusCode >= 200 && res.statusCode <= 599 ? res.statusCode : 502;
      const empty = init.method === "HEAD" || status === 204 || status === 205 || status === 304;
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? "", headers }));
    });
    // Failing the way fetch fails: describeFetchError reads the reason from `cause`.
    req.on("error", (err) => reject(err.name === "AbortError" ? err : Object.assign(new TypeError("fetch failed"), { cause: err })));
    req.end(init.body ?? undefined);
  });
}

/** How requests to user-supplied URLs go out (tests put a stand-in here). */
export const outbound = { send };

/**
 * A request to a user-supplied URL: checked with assertPublicHttpUrl first, and its address checked again as it
 * connects. A redirect comes back as it is (see safeFetch).
 */
export async function publicFetch(raw: string, init: OutboundInit = {}): Promise<Response> {
  const url = await assertPublicHttpUrl(raw);
  return outbound.send(url.toString(), init);
}

/** publicFetch that follows redirects, each hop checked the same way, so a public URL can't bounce into a private network. */
export async function safeFetch(raw: string, init: OutboundInit = {}, maxRedirects = 4): Promise<Response> {
  let url = raw;
  for (let hop = 0; ; hop++) {
    const res = await publicFetch(url, init);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    if (hop >= maxRedirects) throw badRequest("Too many redirects");
    await res.body?.cancel().catch(() => {});
    url = new URL(location, url).toString();
  }
}

/** A response's body as text, at most `max` bytes of it: a server that sends more is cut off, not waited for. */
export async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

/** A readable reason for a failed outbound request (fetch reports most network failures as "fetch failed"). */
export function describeFetchError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "No answer within the time limit";
  switch (e?.cause?.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "The host name could not be found";
    case "ECONNREFUSED":
      return "The server refused the connection";
    case "ECONNRESET":
      return "The connection was reset";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "The server could not be reached";
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "The server's TLS certificate is not valid";
  }
  return (e?.cause?.message || e?.message || "Request failed").slice(0, 200);
}
