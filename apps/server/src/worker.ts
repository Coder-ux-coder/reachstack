// Standalone background engine (use when RUN_WORKER_IN_PROCESS=false).
import { initDb } from "./db/client";
import { startEngine, stopEngine } from "./engine";
import "./engine/register";
import { pauseSendingAfterRestore } from "./services/backups";
import { startServiceSettingsSync } from "./services/service-settings";

await initDb();
// The same keys and services as the API: what the owner saved in Settings → Installation → Services.
await startServiceSettingsSync();
// After a restore, campaigns wait until someone has looked (`npm run restore` then starting the worker first).
await pauseSendingAfterRestore();
startEngine();
console.log("Background engine started");
const stop = async () => {
  await stopEngine();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
