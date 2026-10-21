// Restores a backup made in Settings → Installation → Backups, with the server stopped:
//
//   npm run restore -w @reachstack/server -- <backup file> [--yes]
//
// It checks the file, then replaces the database, the secret key and the attachments and uploads folders in DATA_DIR.
// What it replaces is kept in DATA_DIR/backups/before-restore-<time>/. Like the server, it reads DATA_DIR and
// APP_SECRET from the repository's .env. It never loads src/env.ts, which would create a new secret key.
import path from "node:path";
import { existsSync, renameSync, rmSync } from "node:fs";
import readline from "node:readline/promises";
import { isatty } from "node:tty";
import { ArchiveError } from "../services/backup-archive";
import { applyPendingRestore, cancelPendingRestore, COMMAND_DIR, dataDirFromEnv, PENDING_DIR, readPendingRestore, stageRestore } from "../services/backup-restore";

const USAGE = `Usage: npm run restore -w @reachstack/server -- <backup file> [--yes]

Replaces this installation's data with a backup (a .tar.gz from Settings → Installation → Backups).
Stop the server first (and the worker, if it runs separately). --yes skips the question.`;

/** Our own server answering on its port means it's running. */
async function serverRunning(): Promise<string | null> {
  const port = Number(process.env.PORT || 4000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { ok?: unknown; brand?: unknown };
    return body.ok === true && typeof body.brand === "string" ? `${body.brand} is running on port ${port}` : null;
  } catch {
    return null;
  }
}

async function confirmed(dataDir: string): Promise<boolean> {
  // Asked of the file descriptor: without a terminal, standard input is never opened.
  if (!isatty(0)) {
    console.error("Run it again with --yes to restore without being asked.");
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl+C at the question means no.
  const stop = new AbortController();
  rl.on("SIGINT", () => stop.abort());
  try {
    const answer = await rl.question(`\nEverything in ${dataDir} is replaced by this backup. Type "restore" to go ahead: `, { signal: stop.signal });
    return answer.trim().toLowerCase() === "restore";
  } catch {
    process.stdout.write("\n");
    return false;
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes") || args.includes("-y");
  const fileArg = args.find((a) => !a.startsWith("-"));
  if (!fileArg || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return fileArg ? 0 : 1;
  }
  // npm runs workspace scripts from apps/server; a relative path means the folder the command was typed in.
  const file = path.resolve(process.env.INIT_CWD || process.cwd(), fileArg);
  if (!existsSync(file)) {
    console.error(`There's no file at ${file}`);
    return 1;
  }
  const running = await serverRunning();
  if (running) {
    console.error(`${running}. Stop it, then run this again.`);
    return 1;
  }

  const dataDir = dataDirFromEnv();
  const waiting = readPendingRestore(dataDir);
  if (waiting) console.log("A restore chosen on the Backups page is waiting. If you go ahead, this one replaces it.");
  console.log(`Checking ${file} …`);
  // Checked in a folder of its own: the waiting restore stays as it is unless this one goes ahead.
  const checked = path.join(dataDir, COMMAND_DIR);
  let pending;
  try {
    pending = await stageRestore(dataDir, file, { source: { type: "command", name: path.basename(file) }, into: COMMAND_DIR });
  } catch (err) {
    console.error(err instanceof ArchiveError ? err.message : `Couldn't read the backup: ${(err as Error).message}`);
    return 1;
  }
  const b = pending.backup;
  const n = (v: number | null | undefined) => (v === null || v === undefined ? "?" : v.toLocaleString("en"));
  console.log(`\nBackup made ${new Date(b.created_at).toLocaleString()} (${b.kind}) by ${b.app.name} ${b.app.version}`);
  console.log(`  ${n(b.counts.users)} people, ${n(b.counts.workspaces)} workspaces, ${n(b.counts.campaigns)} campaigns, ${n(b.counts.leads)} leads, ${n(b.counts.emails)} emails, ${n(b.files)} files`);
  if (!pending.secret_matches) {
    console.log(
      b.secret_key_source === "environment"
        ? "  Warning: this backup was made with APP_SECRET set. Set APP_SECRET to the same value before you start the server, or saved mailbox passwords and keys won't be readable."
        : "  Warning: APP_SECRET is set here, so the server won't use the backup's secret key. Remove APP_SECRET before you start the server, or saved mailbox passwords and keys won't be readable.",
    );
  }
  if (!yes && !(await confirmed(dataDir))) {
    rmSync(checked, { recursive: true, force: true });
    console.log(waiting ? "Nothing was changed. The restore chosen on the Backups page is still waiting." : "Nothing was changed.");
    return 1;
  }
  await cancelPendingRestore(dataDir);
  renameSync(checked, path.join(dataDir, PENDING_DIR));
  const result = applyPendingRestore(dataDir, { log: () => undefined });
  if (!result.applied) {
    console.error(result.error ?? "Couldn't restore the backup.");
    console.error("The restore is still waiting: the server finishes it when it starts, or run this again.");
    return 1;
  }
  console.log(`\nRestored. What it replaced is in ${result.replacedDir}`);
  console.log("Start the server as usual. Campaigns that were sending are paused when it starts, so nothing goes out twice: resume them once you've checked.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
