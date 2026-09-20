import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  pauseForDeployment,
  resumeAfterDeployment,
} from "./deployment-drain.mjs";

const id = "00000000-0000-4000-8000-000000000001";
test("a stale acknowledgement cannot activate a release and timeout cleanup resumes processing", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "p2a-deploy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "deployment-drain-status.json"),
    JSON.stringify({ id: "old", drained: true, active: 0 }),
  );

  await assert.rejects(pauseForDeployment(directory, id, 20), /timed out/);
  await resumeAfterDeployment(directory, "someone-else");
  assert.equal(
    JSON.parse(
      await readFile(path.join(directory, "deployment-drain.json"), "utf8"),
    ).id,
    id,
  );
  await resumeAfterDeployment(directory, id);

  await assert.rejects(
    readFile(path.join(directory, "deployment-drain.json")),
    { code: "ENOENT" },
  );
});

test("only the matching zero-active acknowledgement allows activation", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "p2a-deploy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "deployment-drain-status.json"),
    JSON.stringify({ id, drained: true, active: 0 }),
  );

  await pauseForDeployment(directory, id, 1000);

  assert.equal(
    JSON.parse(
      await readFile(path.join(directory, "deployment-drain.json"), "utf8"),
    ).id,
    id,
  );
  await assert.rejects(pauseForDeployment(directory, id), { code: "EEXIST" });
});
