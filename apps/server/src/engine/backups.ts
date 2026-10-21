// The "backups" engine loop: makes the automatic backup when the owner's schedule says so (Settings → Installation →
// Backups), deletes exports once they've been kept long enough, and what an interrupted restore left behind. Importing
// the export service here also registers its background job in the engine's process (the API, or a separate worker).
import { config } from "../env";
import { removeRestoreLeftovers } from "../services/backup-restore";
import { runScheduledBackup } from "../services/backups";
import { removeOldExports } from "../services/workspace-export";

export async function runBackups() {
  await removeOldExports();
  await removeRestoreLeftovers(config.dataDir);
  await runScheduledBackup();
}
