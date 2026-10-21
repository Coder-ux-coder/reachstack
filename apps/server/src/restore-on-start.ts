// Imported first by src/index.ts: finishes a restore that's waiting (Settings → Installation → Backups) before anything
// opens the database or reads the secret key. Keep it ahead of every other import there.
import { applyPendingRestore, dataDirFromEnv } from "./services/backup-restore";

applyPendingRestore(dataDirFromEnv());
