// Connection test results (IMAP and SMTP) for toasts: what failed, and the server's plain-words hint on what to do.
import { toast } from "sonner";

export interface ConnectionCheck {
  ok: boolean;
  error?: string;
  code?: string;
  hint?: string;
}

export interface ConnectionTest {
  ok: boolean;
  imap: ConnectionCheck;
  smtp: ConnectionCheck;
}

/** Shows a failed test: each failing side's error, with the hint underneath (once when both sides share it). */
export function toastFailedTest(r: ConnectionTest, fallback = "The connection test failed") {
  const failed = (["imap", "smtp"] as const).filter((side) => !r[side].ok);
  const title = failed.map((side) => `${side.toUpperCase()}: ${r[side].error ?? "failed"}`).join(" · ") || fallback;
  const hints = [...new Set(failed.map((side) => r[side].hint).filter((h): h is string => !!h))];
  toast.error(title, hints.length ? { description: hints.join(" "), duration: 12_000 } : undefined);
}
