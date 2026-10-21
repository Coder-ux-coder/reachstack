// One background engine per database (src/engine/lease.ts): a second server or worker started on the same data stands
// by, so emails never go out twice, and takes over when the first stops, at once when its process is gone.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { eq, like } from "drizzle-orm";
import { startServer, stopServer } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { engineRunsHere, engineTiming, keepSending, registerLoop, startEngine, stopEngine, syncLease } from "../src/engine";
import { claimLease, holdsLease, LEASE_KEY, LEASE_TTL_MS, readLease, releaseLease, type EngineLease } from "../src/engine/lease";

const S = schema.appSettings;

async function setLease(lease: EngineLease | null) {
  await db.delete(S).where(eq(S.key, LEASE_KEY));
  if (lease) await db.insert(S).values({ key: LEASE_KEY, value: lease });
}

/** A lease held by another process: by default the test runner (alive, on this computer), renewed just now. */
const elsewhere = (over: Partial<EngineLease> = {}): EngineLease => ({
  token: "another-process",
  pid: process.ppid,
  host: hostname(),
  acquired_at: new Date().toISOString(),
  expires_at: Date.now() + LEASE_TTL_MS,
  ...over,
});

/** The pid of a process that has exited. */
function exitedPid(): number {
  return Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What processes standing by noted (a restore waits for them, engine/lease.ts noteStandby). */
const standbyNotes = () => db.select().from(S).where(like(S.key, "engine_standby:%"));

before(startServer);
after(stopServer);

describe("engine lease", () => {
  it("takes a free lease and keeps renewing it", async () => {
    await setLease(null);
    assert.equal(await claimLease(), true);
    assert.equal(holdsLease(), true);
    const first = (await readLease())!;
    assert.equal(first.pid, process.pid);

    await pause(5);
    assert.equal(await claimLease(), true);
    const renewed = (await readLease())!;
    assert.equal(renewed.token, first.token);
    assert.equal(renewed.acquired_at, first.acquired_at, "a renewal keeps when it was first taken");
    assert.ok(renewed.expires_at > first.expires_at);
  });

  it("waits while another process holds it", async () => {
    await setLease(elsewhere());
    assert.equal(await claimLease(), false);
    assert.equal(holdsLease(), false);
    assert.equal((await readLease())!.token, "another-process", "the holder's lease is left alone");

    // On another computer the process can't be looked up, so the lease is waited out even when that pid isn't running here.
    await setLease(elsewhere({ host: "another-computer", pid: exitedPid() }));
    assert.equal(await claimLease(), false);
  });

  it("takes over at once when the holder's process is gone, and anywhere once the lease ran out", async () => {
    await setLease(elsewhere({ pid: exitedPid() }));
    assert.equal(await claimLease(), true, "its process on this computer has exited");

    await setLease(elsewhere({ host: "another-computer", expires_at: Date.now() - 1 }));
    assert.equal(await claimLease(), true, "a minute without renewal");
    assert.equal((await readLease())!.pid, process.pid);
  });

  it("gives it up when released", async () => {
    await setLease(null);
    assert.equal(await claimLease(), true);
    await releaseLease();
    assert.equal(holdsLease(), false);
    assert.equal(await readLease(), null);

    // Releasing never removes another process's lease.
    await setLease(elsewhere());
    await releaseLease();
    assert.equal((await readLease())!.token, "another-process");
  });

  it("the engine's loops run only while this process holds the lease", async () => {
    engineTiming.firstRunMs = 0;
    engineTiming.firstRunSpreadMs = 1;
    let runs = 0;
    registerLoop("lease-test", 60 * 60_000, async () => {
      runs++;
    });

    await setLease(elsewhere());
    startEngine();
    await syncLease();
    await pause(50);
    assert.equal(runs, 0, "standing by while another process runs the engine");
    assert.equal(engineRunsHere(), false);
    const notes = await standbyNotes();
    assert.equal(notes.length, 1, "standing by is noted, so a restore waits for this process too");
    assert.equal((notes[0]!.value as { pid: number }).pid, process.pid);

    // The other process stopped without giving the lease up; once it runs out, this one takes over.
    await setLease(elsewhere({ expires_at: Date.now() - 1 }));
    await syncLease();
    await pause(50);
    assert.equal(runs, 1, "the loops start on taking over");
    assert.equal(engineRunsHere(), true);
    assert.deepEqual(await standbyNotes(), [], "the note goes once this process runs the engine");

    await stopEngine();
    assert.equal(await readLease(), null, "stopping gives the lease up for the next process");
    assert.equal(engineRunsHere(), false);
  });

  it("a process that stops while standing by takes its note with it", async () => {
    await setLease(elsewhere());
    startEngine();
    await syncLease();
    assert.equal((await standbyNotes()).length, 1);
    await stopEngine();
    assert.deepEqual(await standbyNotes(), []);
  });

  it("stopping lets a pass finish the email it's on before the lease goes to the next process", async () => {
    let finish: () => void = () => undefined;
    let toldToStop = false;
    registerLoop("slow-pass", 60 * 60_000, async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      toldToStop = !keepSending();
    });
    await setLease(null);
    startEngine();
    await syncLease();
    await pause(50);
    assert.equal(keepSending(), true);
    const stopping = stopEngine();
    await pause(30);
    assert.ok(await readLease(), "the lease is kept while the pass is still sending");
    finish();
    await stopping;
    assert.equal(toldToStop, true, "the pass was told to stop at its next safe point");
    assert.equal(await readLease(), null);
  });
});
