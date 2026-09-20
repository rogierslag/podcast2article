import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RequestDrain, startDeploymentDrain } from "./deployment-drain.js";

const directories: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it("acknowledges a drain only after active results are persisted and resumes when its marker is removed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "p2a-drain-"));
  directories.push(directory);
  const gate = new RequestDrain();
  const release = await gate.acquire();
  const id = "00000000-0000-4000-8000-000000000001";
  await writeFile(
    path.join(directory, "deployment-drain.json"),
    JSON.stringify({ id }),
  );
  stops.push(await startDeploymentDrain(directory, gate));
  const status = async () =>
    JSON.parse(
      await readFile(
        path.join(directory, "deployment-drain-status.json"),
        "utf8",
      ),
    );
  let admitted = false;
  const next = gate.acquire().then((finish) => {
    admitted = true;
    return finish;
  });

  expect(await status()).toEqual({ id, active: 1, drained: false });
  expect(admitted).toBe(false);
  release();
  await vi.waitFor(async () =>
    expect(await status()).toEqual({ id, active: 0, drained: true }),
  );
  expect(admitted).toBe(false);
  await rm(path.join(directory, "deployment-drain.json"));
  const finish = await next;

  expect(admitted).toBe(true);
  finish();
  expect(gate.pending).toBe(0);
});

it("cancels a paused admission without starting a request", async () => {
  const gate = new RequestDrain();
  gate.pause();
  const controller = new AbortController();
  const pending = gate.acquire(controller.signal);

  controller.abort();

  await expect(pending).rejects.toThrow();
  expect(gate.pending).toBe(0);
});
