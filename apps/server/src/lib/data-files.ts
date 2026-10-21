// Files under DATA_DIR are recorded in the database relative to it, so the project or its data folder can move.
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../env";

/** The value to store for a file inside DATA_DIR: relative, with forward slashes. */
export function toStoredPath(file: string): string {
  return path.relative(config.dataDir, file).split(path.sep).join("/");
}

/**
 * Absolute path of a stored file. Older rows hold absolute paths: they are used as they are while the file
 * is still there, otherwise re-rooted at this DATA_DIR from their "attachments" segment on.
 */
export function resolveStoredPath(stored: string): string {
  const parts = stored.split(/[\\/]+/).filter(Boolean);
  const absolute = path.isAbsolute(stored) || /^[a-zA-Z]:[\\/]/.test(stored);
  if (!absolute) return path.join(config.dataDir, ...parts);
  if (existsSync(stored)) return stored;
  const at = parts.lastIndexOf("attachments");
  return at >= 0 ? path.join(config.dataDir, ...parts.slice(at)) : stored;
}
