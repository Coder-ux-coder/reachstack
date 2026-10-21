// /app/settings/installation/backups — the installation owner's backups: make one now or on a schedule, download or
// delete them, and restore one. A restore is checked at once and swapped in when the server restarts.
import { Fragment, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";
import { ArchiveRestore, DatabaseBackup, Download, ShieldOff, Trash2, Upload } from "lucide-react";
import { BACKUP_FREQUENCIES, BACKUP_FREQUENCY_LABELS, BACKUP_KEEP_MAX, type BackupFrequency, type BackupSchedule } from "@reachstack/shared";
import { ApiError, del, errorMessage, get, patch, post } from "@/lib/api";
import { ago, bytes, dateTime, plural } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Badge, Button, buttonClass, Callout, Card, CardHeader, CopyButton, Dialog, EmptyState, Field, Input, MenuItem, MenuSeparator, NativeSelect, NumberInput, Progress, RowMenu, Spinner, useConfirm } from "@/components/ui";
import { RestartButton } from "./RestartButton";

// ---------- Types ----------

type BackupKind = "manual" | "automatic";

interface BackupFile {
  id: string;
  created_at: string;
  kind: BackupKind;
  bytes: number;
}

interface RestoreSource {
  type: "upload" | "backup" | "command";
  name: string;
}

interface PendingRestore {
  staged_at: string;
  source: RestoreSource;
  backup: {
    created_at: string;
    kind: BackupKind;
    app: { name: string; version: string };
    database_bytes: number;
    counts: Record<string, number | null>;
    files: number;
    secret_key_included: boolean;
    secret_key_source: "file" | "environment";
  };
  secret_matches: boolean;
  last_attempt: { at: string; error: string } | null;
}

interface BackupsOverview {
  backups: BackupFile[];
  running: { kind: BackupKind; started_at: string } | null;
  last: { at: string; kind: BackupKind; ok: boolean; id?: string; bytes?: number; duration_ms: number; error?: string } | null;
  schedule: BackupSchedule;
  next_automatic_at: string | null;
  time_zone: string;
  storage: { backups_dir: string; data_dir: string; free_bytes: number | null; backups_bytes: number };
  secret_key: { source: "file" | "environment" };
  worker_in_process: boolean;
  /** Whether the server can restart itself from here (services/restart.ts). */
  can_restart: boolean;
  pending_restore: PendingRestore | null;
  last_restore: {
    restored_at: string;
    backup_created_at: string;
    source: RestoreSource;
    replaced_dir: string;
    /** What the first start after it paused, so nothing sent after the backup was made goes out twice. */
    paused?: { campaigns: number; scheduled_emails: number };
  } | null;
}

type RestoreTarget = { type: "upload" } | { type: "backup"; backup: BackupFile };

const KEY = ["installation", "backups"];
const RESTORE_COMMAND = "npm run restore -w @reachstack/server -- <file>";
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const hourLabel = (h: number) => `${h % 12 || 12}:00 ${h < 12 ? "AM" : "PM"}`;

/** A time on the server's clock, the clock automatic backups follow. */
function serverTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
  } catch {
    return dateTime(iso);
  }
}

function countsLine(c: Record<string, number | null>): string | null {
  const parts = [
    c.users != null && plural(c.users, "person", "people"),
    c.workspaces != null && plural(c.workspaces, "workspace"),
    c.campaigns != null && plural(c.campaigns, "campaign"),
    c.leads != null && plural(c.leads, "lead"),
    c.emails != null && plural(c.emails, "email"),
  ].filter((p): p is string => !!p);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Sends a backup with upload progress (fetch can't report it). The server reads the password before the file. */
function uploadBackup(file: File, password: string, onStart: (xhr: XMLHttpRequest) => void, onProgress: (pct: number) => void): Promise<BackupsOverview> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("password", password);
    form.append("file", file, file.name);
    const xhr = new XMLHttpRequest();
    onStart(xhr);
    xhr.open("POST", "/api/app/admin/backups/restore");
    xhr.setRequestHeader("x-rs-csrf", "1");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.floor((e.loaded / e.total) * 100));
    };
    xhr.upload.onload = () => onProgress(100);
    xhr.onload = () => {
      let data: { message?: string; code?: string } | null = null;
      try {
        data = JSON.parse(xhr.responseText) as { message?: string; code?: string };
      } catch {
        // not JSON (a proxy's error page)
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as unknown as BackupsOverview);
      else reject(new ApiError(xhr.status, data?.message || "The upload didn't finish. Try again.", data?.code));
    };
    xhr.onerror = () => reject(new ApiError(0, "Can't reach the server. Check your connection and try again."));
    xhr.onabort = () => reject(new ApiError(0, "Upload stopped", "aborted"));
    xhr.send(form);
  });
}

// ---------- Page ----------

export function InstallationBackups() {
  const me = useSession();
  // Backups is the last tab: on a phone it starts out of view, so bring it into the tab row's view.
  useEffect(() => {
    document.querySelector<HTMLElement>('nav a[aria-current="page"][href$="/installation/backups"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);
  if (!me.features.owner) {
    return (
      <EmptyState
        icon={<ShieldOff size={24} />}
        title="Only the owner of this installation can see backups"
        description="A backup holds everything on this installation, including the key to saved mailbox passwords."
      />
    );
  }
  return <Backups />;
}

function Backups() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => get<BackupsOverview>("/api/app/admin/backups"),
    refetchInterval: (query) => (query.state.data?.running ? 2000 : 30_000),
  });
  const d = q.data;
  const [starting, setStarting] = useState(false);
  const [restoring, setRestoring] = useState<RestoreTarget | null>(null);
  const set = (next: BackupsOverview) => qc.setQueryData(KEY, next);

  // Say how a backup went once it's finished (one made here, or an automatic one while the page is open).
  const lastSeen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!d || d.running) return;
    const at = d.last?.at ?? null;
    if (lastSeen.current !== undefined && at && at !== lastSeen.current && d.last) {
      if (d.last.ok) toast.success(`Backup made (${bytes(d.last.bytes ?? 0)})`);
      else toast.error(`The backup failed: ${d.last.error ?? "no reason was given"}`);
    }
    lastSeen.current = at;
  }, [d]);

  const backUpNow = async () => {
    setStarting(true);
    try {
      set(await post<BackupsOverview>("/api/app/admin/backups"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const remove = async (b: BackupFile) => {
    const ok = await confirm({
      title: "Delete this backup?",
      description: `The backup from ${dateTime(b.created_at)} is deleted from the server. This can't be undone.`,
      confirmLabel: "Delete backup",
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/app/admin/backups/${encodeURIComponent(b.id)}`);
      await qc.invalidateQueries({ queryKey: KEY });
      toast.success("Backup deleted");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const cancelRestore = async () => {
    const ok = await confirm({
      title: "Cancel this restore?",
      description: "Nothing is replaced when the server restarts. To restore this backup later, choose it again.",
      confirmLabel: "Don't restore",
    });
    if (!ok) return;
    try {
      set(await del<BackupsOverview>("/api/app/admin/backups/restore"));
      toast.success("The restore is cancelled");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // A failed refresh keeps showing what was loaded; the page asks again on its own.
  if (!d) return q.isError ? <Callout tone="bad">{errorMessage(q.error)}</Callout> : <p className="text-sm text-muted">Loading…</p>;
  const pending = d.pending_restore;
  const recentRestore = !pending && d.last_restore && Date.now() - new Date(d.last_restore.restored_at).getTime() < 7 * 86_400_000 ? d.last_restore : null;

  return (
    <div className="space-y-5">
      {pending && <PendingRestoreCallout pending={pending} overview={d} onCancel={cancelRestore} />}
      {recentRestore && (
        <Callout tone="ok" title={`Restored the backup from ${dateTime(recentRestore.backup_created_at)}`}>
          <p>Restored {ago(recentRestore.restored_at)}. The data it replaced is kept here. Delete that folder once everything looks right.</p>
          <p className="mt-1 flex min-w-0 items-center gap-1.5">
            <code className="min-w-0 break-all text-xs text-text">{recentRestore.replaced_dir}</code>
            <CopyButton value={recentRestore.replaced_dir} />
          </p>
          {!!recentRestore.paused && recentRestore.paused.campaigns + recentRestore.paused.scheduled_emails > 0 && <PausedNote paused={recentRestore.paused} />}
        </Callout>
      )}

      <Callout tone="warn" title="Keep backups private">
        {d.secret_key.source === "file"
          ? "A backup holds everything on this installation, including the secret key that unlocks saved mailbox passwords and API keys. Anyone who has a backup file can read all of it."
          : "A backup holds everything on this installation except the secret key, which comes from the APP_SECRET setting. Keep a copy of APP_SECRET somewhere safe: without it, the mailbox passwords and API keys in a backup can't be read. Anyone who has both can read all of it."}
      </Callout>

      <Card>
        <CardHeader
          className="flex-col sm:flex-row"
          title="Backups"
          description={
            d.secret_key.source === "file"
              ? "The database, the attached and uploaded files and the secret key, in one file. Everything keeps running while it's made."
              : "The database and the attached and uploaded files, in one file. Everything keeps running while it's made."
          }
          actions={
            <Button variant="primary" icon={<DatabaseBackup size={14} />} loading={starting || !!d.running} onClick={backUpNow}>
              Back up now
            </Button>
          }
        />
        {d.running && (
          <div className="mb-4 flex items-center gap-2.5 rounded-lg bg-panel-2 px-3 py-2.5 text-[13px]">
            <Spinner size={14} className="text-muted" />
            <span className="min-w-0">
              Making {d.running.kind === "automatic" ? "the automatic" : "a"} backup, started {ago(d.running.started_at)}. A big database can take a few minutes.
            </span>
          </div>
        )}
        {!d.running && d.last && !d.last.ok && (
          <Callout tone="bad" className="mb-4" title={`The last ${d.last.kind === "automatic" ? "automatic " : ""}backup failed ${ago(d.last.at)}`}>
            {d.last.error}
          </Callout>
        )}
        {d.backups.length ? (
          <ul className="divide-y divide-line">
            {d.backups.map((b) => (
              <li key={b.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium">
                    <span>{dateTime(b.created_at)}</span>
                    <Badge tone={b.kind === "automatic" ? "info" : "neutral"}>{b.kind === "automatic" ? "Automatic" : "Manual"}</Badge>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {bytes(b.bytes)} · {ago(b.created_at)}
                  </p>
                </div>
                <a href={`/api/app/admin/backups/${encodeURIComponent(b.id)}/download`} download className={buttonClass("secondary", "sm")} aria-label={`Download the backup from ${dateTime(b.created_at)}`}>
                  <Download size={14} />
                  <span className="hidden sm:inline">Download</span>
                </a>
                <RowMenu label={`More for the backup from ${dateTime(b.created_at)}`}>
                  <MenuItem icon={<ArchiveRestore size={14} />} onSelect={() => setRestoring({ type: "backup", backup: b })}>
                    Restore this backup
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => void remove(b)}>
                    Delete
                  </MenuItem>
                </RowMenu>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState className="rounded-xl border border-dashed border-line py-6" title="No backups yet" description="Make one now, or turn on automatic backups below." />
        )}
        <div className="mt-4 space-y-1 border-t border-line pt-3 text-xs text-muted">
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5">
            <span>Kept in</span>
            <span className="flex min-w-0 items-center gap-1">
              <code className="min-w-0 break-all text-text">{d.storage.backups_dir}</code>
              <CopyButton value={d.storage.backups_dir} />
            </span>
          </p>
          <p>
            {plural(d.backups.length, "backup")}, {bytes(d.storage.backups_bytes)}
            {d.storage.free_bytes !== null && ` · ${bytes(d.storage.free_bytes)} free on this disk`}. A backup on the same disk as the data is lost with it: download one now and then, or copy
            this folder to another disk.
          </p>
        </div>
      </Card>

      <ScheduleCard overview={d} onSaved={set} />

      <Card>
        <CardHeader
          className="flex-col sm:flex-row"
          title="Restore"
          description="Replace everything on this installation with a backup: people, workspaces, campaigns, emails and files."
          actions={
            <Button icon={<Upload size={14} />} onClick={() => setRestoring({ type: "upload" })}>
              Upload a backup
            </Button>
          }
        />
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">
          <li>The file is checked first. Nothing changes until you restart the server.</li>
          <li>To use a backup kept on this server, choose Restore in its menu above.</li>
          <li>The data it replaces is kept in the backups folder, so you can go back.</li>
        </ul>
        <div className="mt-4 rounded-lg bg-panel-2 px-3 py-2.5 text-[13px]">
          <p className="text-muted">You can also restore on the server itself, with the app stopped:</p>
          <p className="mt-1 flex min-w-0 items-center gap-1.5">
            <code className="min-w-0 text-xs">
              {/* Wraps between words only, never inside "--". */}
              {RESTORE_COMMAND.split(" ").map((word, i) => (
                <Fragment key={i}>
                  {i > 0 && " "}
                  <span className="whitespace-nowrap">{word}</span>
                </Fragment>
              ))}
            </code>
            <CopyButton value={RESTORE_COMMAND} />
          </p>
        </div>
      </Card>

      {restoring && (
        <RestoreDialog
          target={restoring}
          replacesPending={!!pending}
          onClose={() => {
            setRestoring(null);
            void qc.invalidateQueries({ queryKey: KEY });
          }}
          onDone={(next) => {
            set(next);
            setRestoring(null);
            toast.success("The backup is checked. Restart the server to finish restoring.");
            // The note about restarting is at the top of the page (the app scrolls inside <main>).
            document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      )}
    </div>
  );
}

/** What the first start after a restore paused, and why. */
function PausedNote({ paused }: { paused: { campaigns: number; scheduled_emails: number } }) {
  const held = [
    paused.campaigns ? `${plural(paused.campaigns, "campaign")} that ${paused.campaigns === 1 ? "was" : "were"} sending` : null,
    paused.scheduled_emails ? `${plural(paused.scheduled_emails, "scheduled email")} that ${paused.scheduled_emails === 1 ? "was" : "were"} due` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const links = [
    paused.campaigns ? { to: "/app/campaigns?status=paused", label: "the campaigns" } : null,
    paused.scheduled_emails ? { to: "/app/unibox?folder=scheduled", label: "the scheduled emails" } : null,
  ].filter((l): l is { to: string; label: string } => !!l);
  return (
    <p className="mt-2">
      What was sent after the backup was made isn't in it, so {held} {paused.campaigns + paused.scheduled_emails === 1 ? "is" : "are"} on hold, to send nothing twice.
      Check the mailboxes' Sent folders for what went out since, then resume{" "}
      {links.map((l, i) => (
        <Fragment key={l.to}>
          {i > 0 && " and "}
          <Link to={l.to} className="font-medium text-text underline underline-offset-2">
            {l.label}
          </Link>
        </Fragment>
      ))}
      .
    </p>
  );
}

// ---------- A restore waiting for the restart ----------

function PendingRestoreCallout({ pending, overview, onCancel }: { pending: PendingRestore; overview: BackupsOverview; onCancel: () => void }) {
  const b = pending.backup;
  const counts = countsLine(b.counts);
  const from =
    pending.source.type === "upload" ? `the uploaded file ${pending.source.name}` : pending.source.type === "backup" ? "kept on this server" : `the file ${pending.source.name}, chosen on the server`;
  return (
    <Callout tone="warn" title="Restart the server to finish restoring">
      <p>
        The backup from {dateTime(b.created_at)} ({from}) is checked and ready. When the server starts again, it replaces everything on this installation. The data it
        replaces is kept in the backups folder. Campaigns that are sending then wait for you to resume them, so nothing sent since the backup goes out twice.
      </p>
      {counts && <p className="mt-1">It holds {counts}.</p>}
      {!overview.worker_in_process && <p className="mt-1">This server runs the background engine as a separate worker: stop the worker too, then start both again.</p>}
      {!pending.secret_matches && (
        <p className="mt-2 font-medium text-bad">
          {b.secret_key_source === "environment"
            ? "This backup was made with the APP_SECRET setting. Set APP_SECRET to the same value before you restart, or the saved mailbox passwords and API keys can't be read."
            : "APP_SECRET is set on this server, so it won't use the backup's secret key. Remove APP_SECRET before you restart, or the saved mailbox passwords and API keys can't be read."}
        </p>
      )}
      {pending.last_attempt && (
        <p className="mt-2 font-medium text-bad">
          The server tried to finish {ago(pending.last_attempt.at)} and couldn't: {pending.last_attempt.error.replace(/^Couldn't finish restoring: /, "").replace(/^The /, "the ")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {overview.can_restart && overview.worker_in_process && (
          <RestartButton
            variant="primary"
            label="Restart and restore"
            title="Restart and restore this backup?"
            description="The server restarts and the backup replaces everything on this installation. The data it replaces is kept in the backups folder. You'll sign in again with an account from the backup."
            confirmLabel="Restart and restore"
          />
        )}
        <Button size="sm" onClick={onCancel}>
          Cancel restore
        </Button>
      </div>
    </Callout>
  );
}

// ---------- Automatic backups ----------

function ScheduleCard({ overview, onSaved }: { overview: BackupsOverview; onSaved: (o: BackupsOverview) => void }) {
  const saved = overview.schedule;
  const [changes, setChanges] = useState<Partial<BackupSchedule>>({});
  const [keep, setKeep] = useState<number | null>(saved.keep);
  const [busy, setBusy] = useState(false);
  const draft: BackupSchedule = { ...saved, ...changes };
  const on = draft.frequency !== "off";
  const keepValid = keep !== null && Number.isInteger(keep) && keep >= 1 && keep <= BACKUP_KEEP_MAX;
  // How many to keep is hidden (and not saved) while automatic backups are off.
  const dirty = (Object.keys(changes) as Array<keyof BackupSchedule>).some((k) => changes[k] !== saved[k]) || (on && keep !== saved.keep);
  const change = (c: Partial<BackupSchedule>) => setChanges((cur) => ({ ...cur, ...c }));

  const save = async () => {
    setBusy(true);
    try {
      const next = await patch<BackupsOverview>("/api/app/admin/backups/schedule", { ...changes, ...(on && keepValid ? { keep } : {}) });
      onSaved(next);
      setChanges({});
      setKeep(next.schedule.keep);
      toast.success(next.schedule.frequency === "off" ? "Automatic backups are off" : "Saved the backup schedule");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Automatic backups"
        description={`Made on the server's clock (${overview.time_zone}). Older automatic backups are deleted; the ones you make yourself are kept until you delete them.`}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="How often">
          {(id) => (
            <NativeSelect
              id={id}
              value={draft.frequency}
              onChange={(v) => change({ frequency: v as BackupFrequency })}
              options={BACKUP_FREQUENCIES.map((f) => ({ value: f, label: BACKUP_FREQUENCY_LABELS[f] }))}
            />
          )}
        </Field>
        {draft.frequency === "weekly" && (
          <Field label="Day">
            {(id) => <NativeSelect id={id} value={String(draft.weekday)} onChange={(v) => change({ weekday: Number(v) })} options={WEEKDAYS.map((w, i) => ({ value: String(i + 1), label: w }))} />}
          </Field>
        )}
        {on && (
          <Field label="Time">
            {(id) => <NativeSelect id={id} value={String(draft.hour)} onChange={(v) => change({ hour: Number(v) })} options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }))} />}
          </Field>
        )}
        {on && (
          <Field label="Keep the newest" error={keepValid ? null : `Between 1 and ${BACKUP_KEEP_MAX}`}>
            {(id) => <NumberInput id={id} value={keep} onChange={setKeep} min={1} max={BACKUP_KEEP_MAX} suffix="backups" className="w-full" />}
          </Field>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">
          {dirty
            ? "Not saved yet."
            : saved.frequency === "off"
              ? "Automatic backups are off."
              : overview.next_automatic_at
                ? `Next one: ${serverTime(overview.next_automatic_at, overview.time_zone)}.`
                : null}
          {!dirty && saved.frequency !== "off" && !overview.worker_in_process && " The separate worker makes them, so keep it running."}
        </p>
        <Button variant="primary" loading={busy} disabled={!dirty || (on && !keepValid)} onClick={save}>
          Save
        </Button>
      </div>
    </Card>
  );
}

// ---------- Restore dialog ----------

function RestoreDialog({ target, replacesPending, onClose, onDone }: { target: RestoreTarget; replacesPending: boolean; onClose: () => void; onDone: (o: BackupsOverview) => void }) {
  const me = useSession();
  const needsPassword = !!me.user.has_password;
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const xhr = useRef<XMLHttpRequest | null>(null);
  // Closing stops an upload that's still sending. Once the file is sent, the check finishes on the server either way
  // and the page shows the waiting restore.
  const sending = useRef(false);
  useEffect(
    () => () => {
      if (sending.current) xhr.current?.abort();
    },
    [],
  );

  const uploading = busy && target.type === "upload" && (progress ?? 0) < 100;
  const submit = async () => {
    setBusy(true);
    setError(null);
    setProgress(target.type === "upload" ? 0 : null);
    sending.current = target.type === "upload";
    try {
      const next =
        target.type === "upload"
          ? await uploadBackup(
              file!,
              password,
              (x) => (xhr.current = x),
              (pct) => {
                sending.current = pct < 100;
                setProgress(pct);
              },
            )
          : await post<BackupsOverview>(`/api/app/admin/backups/${encodeURIComponent(target.backup.id)}/restore`, { password });
      onDone(next);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "aborted")) setError(errorMessage(e));
      setBusy(false);
      setProgress(null);
    } finally {
      sending.current = false;
      xhr.current = null;
    }
  };
  const close = () => {
    if (sending.current) xhr.current?.abort();
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && close()}
      title={target.type === "upload" ? "Restore from a file" : "Restore this backup"}
      description="When the server restarts, the backup replaces everything on this installation. The data there now is kept in the backups folder."
      footer={
        <>
          <Button onClick={close}>{uploading ? "Stop upload" : busy ? "Close" : "Cancel"}</Button>
          <Button variant="danger" loading={busy} disabled={(target.type === "upload" && !file) || (needsPassword && !password)} onClick={submit}>
            {target.type === "upload" ? "Upload and check" : "Check and restore"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {replacesPending && <Callout tone="info">A restore is already waiting. This one takes its place.</Callout>}
        {target.type === "backup" ? (
          <p className="text-[13px]">
            The backup from <span className="font-medium">{dateTime(target.backup.created_at)}</span> ({bytes(target.backup.bytes)}).
          </p>
        ) : (
          <Field label="Backup file" hint="A .tar.gz file from this page, up to 50 GB. For a bigger one, restore it on the server instead.">
            {(id) => (
              <input
                id={id}
                type="file"
                accept=".gz,.tgz,application/gzip"
                disabled={busy}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full min-w-0 text-[13px] text-muted file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-panel file:px-3 file:py-1.5 file:text-[13px] file:font-medium file:text-text hover:file:bg-panel-2"
              />
            )}
          </Field>
        )}
        {needsPassword && (
          <Field label="Your password">
            {(id) => <Input id={id} type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
        )}
        {busy && (
          <div className="space-y-2 text-[13px]">
            <p className="flex items-center gap-2 text-muted">
              <Spinner size={14} />
              {uploading ? `Uploading… ${progress ?? 0}%` : "Checking the backup…"}
            </p>
            {target.type === "upload" && <Progress value={progress ?? 0} />}
          </div>
        )}
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Dialog>
  );
}
