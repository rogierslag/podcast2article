import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = await readFile("scripts/update-production.sh", "utf8");
// Exercise the production status writer and EXIT trap without deploying code.
const preamble = script.slice(0, script.indexOf("exec 9>"));
for (const [name, action, failed, exitCode] of [
  [
    "failed update persists a failure",
    "deployment_attempted=true; exit 1",
    true,
    1,
  ],
  [
    "successful update clears an earlier failure",
    "deployment_attempted=true; write_deployment_status false; exit 0",
    false,
    0,
  ],
  ["skipped update preserves an earlier failure", "exit 0", true, 0],
]) {
  test(name, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "p2a-update-status-"));
    const marker = path.join(directory, "deployment-status.json");
    try {
      await writeFile(marker, JSON.stringify({ failed: exitCode === 0 }));
      const result = await run("bash", [
        "-c",
        `${preamble}\ndeployment_status="$1"\n${action}`,
        "test",
        marker,
      ]).then(
        () => 0,
        (error) => error.code,
      );

      assert.equal(result, exitCode);
      assert.equal(JSON.parse(await readFile(marker, "utf8")).failed, failed);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("updater persists verified target and keeps its original deadline across retries", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "p2a-update-state-"));
  const marker = path.join(directory, "deployment-status.json");
  const target = "b".repeat(40);
  const observed = Date.now() - 31 * 60_000;
  try {
    await writeFile(
      marker,
      JSON.stringify({
        failed: true,
        targetCommit: target,
        targetObservedAt: observed,
      }),
    );
    await run("bash", [
      "-c",
      `${preamble}\ndeployment_status="$1"\nremote_commit="$2"\nwrite_deployment_status deploying`,
      "test",
      marker,
      target,
    ]);

    const state = JSON.parse(await readFile(marker, "utf8"));
    assert.equal(state.phase, "deploying");
    assert.equal(state.targetCommit, target);
    assert.equal(state.targetObservedAt, observed);
    assert.equal(state.failed, true);
    assert.ok(state.lastCheckedAt > observed);

    await run("bash", [
      "-c",
      `${preamble}\ndeployment_status="$1"\nwrite_deployment_status checking\ndeployment_attempted=true\nexit 1`,
      "test",
      marker,
    ]).catch(() => {});
    const failed = JSON.parse(await readFile(marker, "utf8"));
    assert.equal(failed.lastCheckedAt, state.lastCheckedAt);
    assert.equal(failed.phase, "failed");
    assert.equal(failed.failed, true);

    await run("bash", [
      "-c",
      `${preamble}\ndeployment_status="$1"\nremote_commit="$2"\nwrite_deployment_status deploying\nwrite_deployment_status false`,
      "test",
      marker,
      "c".repeat(40),
    ]);
    const recovered = JSON.parse(await readFile(marker, "utf8"));
    assert.equal(recovered.targetCommit, "c".repeat(40));
    assert.ok(recovered.targetObservedAt > observed);
    assert.equal(recovered.phase, "idle");
    assert.equal(recovered.failed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
