import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { deploymentFailed } from "./deployment.js";

let directory: string;
let statusFile: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "p2a-deployment-"));
  statusFile = path.join(directory, "status.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
it("does not infer a deployment failure from missing state", async () => {
  expect(await deploymentFailed(statusFile)).toBe(false);
});
it.each(["broken", "null", "true", '{"failed":"true"}', '{"failed":false}'])(
  "ignores invalid or healthy state: %s",
  async (status) => {
    await writeFile(statusFile, status);

    expect(await deploymentFailed(statusFile)).toBe(false);
  },
);
it("reads persisted failure and subsequent recovery", async () => {
  await writeFile(statusFile, '{"failed":true}');

  expect(await deploymentFailed(statusFile)).toBe(true);

  await writeFile(statusFile, '{"failed":false}');

  expect(await deploymentFailed(statusFile)).toBe(false);
});
