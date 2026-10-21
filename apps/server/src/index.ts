// Must stay the first import: a restore waiting from Settings → Installation → Backups is applied before the database
// and the secret key are opened.
import "./restore-on-start";
import { initDb } from "./db/client";
import { config } from "./env";
import { buildApp } from "./http/app";
import { pauseSendingAfterRestore } from "./services/backups";
import { bootstrapInstallation } from "./services/bootstrap";

async function main() {
  await initDb();
  await bootstrapInstallation();
  // After a restore, campaigns wait until someone has looked (what was sent after the backup isn't in it).
  await pauseSendingAfterRestore();
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  console.log(`\n  ${config.brandName} is running → ${config.appUrl}\n`);
  if (config.runWorkerInProcess) {
    await import("./engine/register");
    const { startEngine } = await import("./engine");
    startEngine();
  }
  const shutdown = async () => {
    try {
      const { stopEngine } = await import("./engine");
      await stopEngine();
    } catch {
      // engine not started
    }
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
