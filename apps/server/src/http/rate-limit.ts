// In-memory request limits for public forms and sign-in: at most `max` hits per key in each window.
import { tooMany } from "./errors";

const attempts = new Map<string, { count: number; until: number }>();

export function rateLimit(key: string, max = 10, windowMs = 15 * 60_000, message = "Too many attempts. Please try again in a few minutes.") {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.until < now) {
    if (attempts.size > 50_000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
    attempts.set(key, { count: 1, until: now + windowMs });
    return;
  }
  a.count++;
  if (a.count > max) throw tooMany(message);
}

// Failed attempts against one account from anywhere (a password guessed from many addresses). Only failures count, so
// someone signing in correctly is never held up by their own successes.
const failures = new Map<string, { count: number; until: number }>();

/** Turns the request away once `key` has had `max` failures in the current window. */
export function assertFewFailures(key: string, max: number, message: string) {
  const f = failures.get(key);
  if (f && f.until >= Date.now() && f.count >= max) throw tooMany(message);
}

export function noteFailure(key: string, windowMs = 60 * 60_000) {
  const now = Date.now();
  const f = failures.get(key);
  if (!f || f.until < now) {
    if (failures.size > 50_000) for (const [k, v] of failures) if (v.until < now) failures.delete(k);
    failures.set(key, { count: 1, until: now + windowMs });
  } else f.count++;
}

export function clearFailures(key: string) {
  failures.delete(key);
}
