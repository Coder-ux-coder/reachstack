// Backup archives: plain .tar.gz files (tar, 7-Zip and the Windows and macOS file managers open them) written and read
// with Node's own zlib, and the SQLite work that must not block the server: copying the live database and checking a
// database run in a process of their own. Nothing here imports the app's settings or database, so a restore can use it
// before either is opened (see ./backup-restore and src/restore-on-start.ts).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pipeline as pipelineCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { z } from "zod";

export const BACKUP_FORMAT = "reachstack-backup";
export const BACKUP_FORMAT_VERSION = 1;

/** A problem with an archive someone gave us, worded for them (routes answer it as a 400). */
export class ArchiveError extends Error {
  override name = "ArchiveError";
}

const BLOCK = 512;
const CHUNK = 1 << 20;
const MAX_OCTAL = 8 ** 11 - 1; // the largest size a plain tar header holds (8 GB)
const DAMAGED = "This file isn't a .tar.gz backup, or it's damaged.";
const ENDS_EARLY = "The file ends too early. It may not have finished downloading or uploading.";

// ---------- Writing ----------

/** One archive entry: bytes in memory, or a file on disk (left out if it disappears before it's read). */
export type TarSource = { name: string; data: Buffer; mtime?: Date } | { name: string; file: string };

function octal(h: Buffer, value: number, offset: number, width: number) {
  h.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
}

function header(name: string, prefix: string, size: number, mtime: Date, type: string): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  octal(h, 0o644, 100, 8);
  octal(h, 0, 108, 8);
  octal(h, 0, 116, 8);
  if (size <= MAX_OCTAL) octal(h, size, 124, 12);
  else {
    // GNU base-256 for bigger files: high bit set, then the size big-endian.
    h[124] = 0x80;
    let v = size;
    for (let i = 135; i > 124; i--) {
      h[i] = v % 256;
      v = Math.floor(v / 256);
    }
  }
  octal(h, Math.max(0, Math.floor(mtime.getTime() / 1000)), 136, 12);
  h.write("        ", 148, 8, "ascii");
  h.write(type, 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  if (prefix) h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

/** A pax record: "<length> key=value\n", where the length counts the whole record in bytes. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const n = Buffer.byteLength(body);
  let length = n + String(n).length;
  if (String(length).length !== String(n).length) length = n + String(length).length;
  return Buffer.from(`${length}${body}`, "utf8");
}

/** Splits a plain ASCII name into the ustar name and prefix fields, or null when it needs a pax header. */
function ustarName(name: string): { name: string; prefix: string } | null {
  if (!/^[\x20-\x7e]*$/.test(name)) return null;
  if (name.length <= 100) return { name, prefix: "" };
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] === "/" && i <= 155 && name.length - i - 1 <= 100) return { prefix: name.slice(0, i), name: name.slice(i + 1) };
  }
  return null;
}

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;

function* entryHeader(name: string, size: number, mtime: Date): Generator<Buffer> {
  const plain = size <= MAX_OCTAL ? ustarName(name) : null;
  if (plain) {
    yield header(plain.name, plain.prefix, size, mtime, "0");
    return;
  }
  // Long or non-ASCII names, and files over 8 GB, go in a pax header that every current tar reads.
  const pax = Buffer.concat([paxRecord("path", name), ...(size > MAX_OCTAL ? [paxRecord("size", String(size))] : [])]);
  const short = name.replace(/[^\x20-\x7e]/g, "_").slice(-100);
  yield header(`PaxHeader/${short}`.slice(0, 100), "", pax.length, mtime, "x");
  yield pax;
  yield Buffer.alloc(padding(pax.length));
  yield header(short, "", size, mtime, "0");
}

/**
 * Writes `entries` to a new .tar.gz at `out` (never overwrites; owner-only permissions where the system has them).
 * Files are streamed, so archives can be bigger than memory. Returns the names of files that disappeared before they
 * could be read.
 */
export async function writeTarGz(out: string, entries: Iterable<TarSource>): Promise<{ missing: string[] }> {
  const missing: string[] = [];
  async function* tar() {
    for (const e of entries) {
      if ("data" in e) {
        yield* entryHeader(e.name, e.data.length, e.mtime ?? new Date());
        yield e.data;
        yield Buffer.alloc(padding(e.data.length));
        continue;
      }
      let info;
      try {
        info = await stat(e.file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          missing.push(e.name);
          continue;
        }
        throw err;
      }
      if (!info.isFile()) continue;
      const size = info.size;
      yield* entryHeader(e.name, size, info.mtime);
      let written = 0;
      if (size > 0) {
        // Exactly the size in the header: a file that grows while it's read is cut there, one that shrinks is padded.
        for await (const chunk of createReadStream(e.file, { start: 0, end: size - 1, highWaterMark: CHUNK })) {
          written += (chunk as Buffer).length;
          yield chunk as Buffer;
        }
      }
      if (written < size) yield Buffer.alloc(size - written);
      yield Buffer.alloc(padding(size));
    }
    yield Buffer.alloc(BLOCK * 2);
  }
  await pipeline(tar, createGzip({ level: 6 }), createWriteStream(out, { flags: "wx", mode: 0o600 }));
  return { missing };
}

// ---------- Reading ----------

class ByteReader {
  private readonly it: AsyncIterator<Buffer>;
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.it = source[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const r = await this.it.next();
    if (r.done) {
      this.ended = true;
      return false;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, r.value]) : r.value;
    return true;
  }

  /** Exactly `n` bytes, or fewer when the data ends first. */
  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) if (!(await this.fill())) break;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(out.length);
    return out;
  }

  /** Between 1 and `max` bytes; empty only at the end of the data. */
  async readSome(max: number): Promise<Buffer> {
    if (!this.buf.length) await this.fill();
    const out = this.buf.subarray(0, max);
    this.buf = this.buf.subarray(out.length);
    return out;
  }

  async skip(n: number) {
    let left = n;
    while (left > 0) {
      const chunk = await this.readSome(Math.min(left, CHUNK));
      if (!chunk.length) throw new ArchiveError(ENDS_EARLY);
      left -= chunk.length;
    }
  }
}

function cString(b: Buffer): string {
  const end = b.indexOf(0);
  return b.toString("utf8", 0, end === -1 ? b.length : end);
}

function parseNumber(b: Buffer, offset: number, width: number): number {
  if (b[offset]! & 0x80) {
    let v = b[offset]! & 0x7f;
    for (let i = offset + 1; i < offset + width; i++) v = v * 256 + b[i]!;
    return v;
  }
  const text = b.toString("ascii", offset, offset + width).replace(/\0.*$/s, "").trim();
  const v = text ? parseInt(text, 8) : 0;
  if (!Number.isFinite(v) || v < 0) throw new ArchiveError(DAMAGED);
  return v;
}

function parseHeader(b: Buffer) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : b[i]!;
  if (parseNumber(b, 148, 8) !== sum) throw new ArchiveError(DAMAGED);
  const name = cString(b.subarray(0, 100));
  const prefix = b.toString("ascii", 257, 262) === "ustar" ? cString(b.subarray(345, 500)) : "";
  return { name: prefix ? `${prefix}/${name}` : name, size: parseNumber(b, 124, 12), type: String.fromCharCode(b[156]!) };
}

function parsePax(data: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const length = Number(data.toString("ascii", pos, space));
    if (!Number.isInteger(length) || length <= 0 || pos + length > data.length) throw new ArchiveError(DAMAGED);
    const record = data.toString("utf8", space + 1, pos + length - 1);
    const eq = record.indexOf("=");
    if (eq > 0) {
      const key = record.slice(0, eq);
      const value = record.slice(eq + 1);
      if (key === "path") out.path = value;
      if (key === "size" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) out.size = Number(value);
    }
    pos += length;
  }
  return out;
}

export interface TarEntry {
  /** The name inside the archive (forward slashes; check it with safeEntryPath before using it as a path). */
  name: string;
  size: number;
  type: "file" | "directory" | "link" | "other";
  /** The entry's bytes. Read them before asking for the next entry; whatever isn't read is skipped. */
  content(): AsyncGenerator<Buffer>;
}

function readableError(err: unknown): Error {
  if (err instanceof ArchiveError) return err;
  const e = err as NodeJS.ErrnoException;
  if (typeof e?.code === "string" && e.code.startsWith("Z_")) return new ArchiveError(e.code === "Z_BUF_ERROR" ? ENDS_EARLY : DAMAGED);
  return err as Error;
}

/** Reads a .tar.gz entry by entry, streaming each one (pax and GNU long names are understood). */
export async function* readTarGz(file: string, opts: { maxEntries?: number } = {}): AsyncGenerator<TarEntry> {
  const source = createReadStream(file);
  const gunzip = createGunzip();
  // Errors from either stream surface while reading `gunzip`.
  pipelineCallback(source, gunzip, () => undefined);
  const reader = new ByteReader(gunzip);
  const maxEntries = opts.maxEntries ?? 20_000_000;
  try {
    let paxPath: string | null = null;
    let paxSize: number | null = null;
    let longName: string | null = null;
    let entries = 0;
    // Headers that describe the next entry (a long name, a big size): one or two come before an entry, never many.
    let described = 0;
    for (;;) {
      const block = await reader.read(BLOCK);
      if (!block.length) return;
      if (block.length < BLOCK) throw new ArchiveError(ENDS_EARLY);
      if (block.every((b) => b === 0)) return;
      const h = parseHeader(block);
      if (h.type === "x" || h.type === "g" || h.type === "L" || h.type === "K") {
        if (h.size > CHUNK || ++described > 8) throw new ArchiveError(DAMAGED);
        const data = await reader.read(h.size);
        if (data.length < h.size) throw new ArchiveError(ENDS_EARLY);
        await reader.skip(padding(h.size));
        if (h.type === "x") {
          const pax = parsePax(data);
          paxPath = pax.path ?? null;
          paxSize = pax.size ?? null;
        } else if (h.type === "L") longName = cString(data);
        continue;
      }
      if (++entries > maxEntries) throw new ArchiveError("The archive holds too many files.");
      described = 0;
      const name = paxPath ?? longName ?? h.name;
      const size = paxSize ?? h.size;
      paxPath = paxSize = longName = null;
      const type = h.type === "0" || h.type === "\0" || h.type === "7" ? "file" : h.type === "5" ? "directory" : h.type === "1" || h.type === "2" ? "link" : "other";
      let remaining = size;
      // The caller runs this generator itself, so its errors don't pass through the catch below.
      const content = async function* () {
        try {
          while (remaining > 0) {
            const chunk = await reader.readSome(Math.min(remaining, CHUNK));
            if (!chunk.length) throw new ArchiveError(ENDS_EARLY);
            remaining -= chunk.length;
            yield chunk;
          }
        } catch (err) {
          throw readableError(err);
        }
      };
      yield { name, size, type, content };
      await reader.skip(remaining);
      await reader.skip(padding(size));
    }
  } catch (err) {
    throw readableError(err);
  } finally {
    gunzip.destroy();
    source.destroy();
  }
}

/**
 * The parts of an entry name, or null when it could point outside the folder it's unpacked into (absolute paths,
 * "..", drive letters, backslashes). A leading "./" is allowed, as some tar tools add it.
 */
export function safeEntryPath(name: string): string[] | null {
  let n = name.replace(/^(\.\/)+/, "");
  if (n.endsWith("/")) n = n.slice(0, -1);
  if (!n || n.startsWith("/") || n.includes("\\") || n.includes("\0") || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || (process.platform === "win32" && p.includes(":")))) return null;
  return parts;
}

// ---------- Files ----------

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: CHUNK })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface FileItem {
  /** Path below the folder, with forward slashes. */
  rel: string;
  abs: string;
  size: number;
}

/** Every regular file below `root` (links and special files are left out), sorted; an empty list when it's missing. */
export async function listFiles(root: string): Promise<FileItem[]> {
  const out: FileItem[] = [];
  async function walk(dir: string, rel: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) {
        try {
          out.push({ rel: r, abs, size: (await stat(abs)).size });
        } catch {
          // removed while we looked
        }
      }
    }
  }
  await walk(root, "");
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** A short hash that tells whether two secret keys are the same one, without revealing either. */
export function secretFingerprint(secret: string): string {
  return createHash("sha256").update(`reachstack-backup-secret-check\n${secret}`).digest("hex").slice(0, 16);
}

// ---------- Manifest ----------

const counts = z.record(z.number().nullable());

export const manifestSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    format_version: z.number().int().min(1),
    app: z.object({ name: z.string(), version: z.string() }).passthrough(),
    created_at: z.string().datetime(),
    kind: z.enum(["manual", "automatic"]),
    database: z
      .object({
        file: z.literal("app.db"),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        migration_at: z.number().nullable(),
        counts: counts.default({}),
      })
      .passthrough(),
    secret_key: z.object({ included: z.boolean(), source: z.enum(["file", "environment"]), fingerprint: z.string() }).passthrough(),
    folders: z.record(z.object({ files: z.number().int().nonnegative(), bytes: z.number().nonnegative() })).default({}),
  })
  .passthrough();

export type BackupManifest = z.infer<typeof manifestSchema>;

/** Checks a manifest.json from an archive; the error says what's wrong in words an owner can act on. */
export function parseManifest(raw: unknown): BackupManifest {
  const r = raw as { format?: unknown; format_version?: unknown } | null;
  if (!r || r.format !== BACKUP_FORMAT) throw new ArchiveError("This file isn't a backup made by this app (its manifest.json is missing or different).");
  if (typeof r.format_version === "number" && r.format_version > BACKUP_FORMAT_VERSION) {
    throw new ArchiveError("This backup was made by a newer version of the app. Update this installation, then restore it.");
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new ArchiveError("This backup's manifest.json is damaged.");
  return parsed.data;
}

// ---------- SQLite in a process of its own ----------

export interface DbInfo {
  tables: string[];
  /** The newest migration the database has (drizzle's created_at, in ms), or null. */
  migration_at: number | null;
  counts: Record<string, number | null>;
  /** PRAGMA quick_check results ("ok" when the file is sound); only for "inspect". */
  check?: string[];
}

export type SqliteTask = { op: "snapshot"; src: string; out: string } | { op: "inspect"; file: string };

// Plain JavaScript for a short-lived node process (no TypeScript loader there). It opens its own connection, so a big
// copy or check never holds up the server's requests, and answers with one line of JSON.
const TASK_SOURCE = `
const Database = require(process.argv[1]);
const task = JSON.parse(process.argv[2]);
const COUNTS = {
  users: "select count(*) as n from users where deleted_at is null",
  workspaces: "select count(*) as n from workspaces where deleted_at is null",
  campaigns: "select count(*) as n from campaigns",
  leads: "select count(*) as n from leads",
  email_accounts: "select count(*) as n from email_accounts",
  emails: "select count(*) as n from emails",
};
function describe(db) {
  const tables = db.prepare("select name from sqlite_master where type = 'table'").all().map((r) => String(r.name));
  const counts = {};
  for (const [key, sql] of Object.entries(COUNTS)) {
    try { counts[key] = Number(db.prepare(sql).get().n); } catch { counts[key] = null; }
  }
  let migration_at = null;
  if (tables.includes("__drizzle_migrations")) {
    const row = db.prepare("select created_at from __drizzle_migrations order by created_at desc limit 1").get();
    migration_at = row && row.created_at !== null && row.created_at !== undefined ? Number(row.created_at) : null;
  }
  return { tables, migration_at, counts };
}
let db = null;
try {
  let info;
  if (task.op === "snapshot") {
    db = new Database(task.src);
    db.exec("PRAGMA busy_timeout = 60000");
    db.prepare("VACUUM INTO ?").run(task.out);
    db.close();
    db = new Database(task.out);
    info = describe(db);
  } else {
    db = new Database(task.file);
    db.exec("PRAGMA busy_timeout = 5000");
    const check = db.prepare("PRAGMA quick_check").all().map((r) => String(r.quick_check));
    info = { ...describe(db), check };
  }
  db.close();
  db = null;
  process.stdout.write(JSON.stringify({ ok: true, info }));
} catch (e) {
  try { if (db) db.close(); } catch {}
  process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
}
`;

const nodeRequire = createRequire(import.meta.url);
let libsqlPath: string | null = null;

/** Where the libsql driver (the one @libsql/client uses) lives. */
export function libsqlModulePath(): string {
  libsqlPath ??= createRequire(nodeRequire.resolve("@libsql/client")).resolve("libsql");
  return libsqlPath;
}

/**
 * Runs a database task in a node process of its own: "snapshot" copies a live database consistently (VACUUM INTO) while
 * the server keeps writing; "inspect" checks a database file. Resolves once that process has exited, so the files are
 * free to move. Not a worker thread: the driver is a native module, and loading it in worker threads one after another
 * now and then crashed the whole process. Note: the driver creates missing files, so check that `src`/`file` exists first.
 */
export function sqliteTask(task: SqliteTask): Promise<DbInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", TASK_SOURCE, libsqlModulePath(), JSON.stringify(task)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      let answer: { ok: true; info: DbInfo } | { ok: false; error: string };
      try {
        answer = JSON.parse(out) as typeof answer;
      } catch {
        const last = err.trim().split(/\r?\n/).pop();
        reject(new Error(last || `The database task stopped without an answer (exit code ${code})`));
        return;
      }
      if (answer.ok) resolve(answer.info);
      else reject(new Error(answer.error));
    });
  });
}
