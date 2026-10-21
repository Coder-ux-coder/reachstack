// Restarting the server from the app (Settings → Installation), to finish a restore or get a stopped engine going. It
// only works when something starts the server again after it exits: `npm run local` (tools/start-local.mjs) does,
// and says so by setting REACHSTACK_SUPERVISOR. Under systemd, Docker or pm2 with a restart policy, set it yourself.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../env";

/** The exit code that asks `npm run local` to start the server again (any exit does under other supervisors). */
export const RESTART_EXIT_CODE = 75;

/** Changes with every start, so the app can tell when a restart has happened. */
export const BOOT_ID = randomUUID().slice(0, 8);

export function canRestart(): boolean {
  return !!config.supervisor;
}

let restarting = false;

/** Stops the engine and the server in a moment (after the reply is sent) and exits so the supervisor starts it again. */
export function restartSoon(app: FastifyInstance) {
  if (restarting) return;
  restarting = true;
  setTimeout(async () => {
    // Whatever happens below, the process exits within half a minute (the engine gets 15 seconds to finish the email
    // it's sending).
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 25_000).unref();
    try {
      const { stopEngine } = await import("../engine");
      await stopEngine();
    } catch {
      // the engine wasn't started in this process
    }
    await app.close().catch(() => undefined);
    process.exit(RESTART_EXIT_CODE);
  }, 300);
}
