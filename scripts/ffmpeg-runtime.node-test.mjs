import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertIdle,
  checkServiceMedia,
  installFfmpeg,
  rollbackFfmpeg,
  runtimePaths,
  selectFfmpeg,
  serviceEnvironment,
  validateManifest,
} from "./ffmpeg-runtime.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "p2a-runtime-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const paths = runtimePaths(root);
  await mkdir(path.dirname(paths.override), { recursive: true });
  return paths;
}

function fakeService(paths, options = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "systemctl" && args[0] === "cat") {
      return {
        stdout: `[Service]\nEnvironmentFile=/etc/podcast2article.env\n${await readFile(paths.override, "utf8").catch(() => "")}`,
      };
    }
    if (command === "systemctl" && args[0] === "start" && options.failSmoke) {
      throw new Error("synthetic media failed");
    }
    if (
      command === "systemctl" &&
      args[0] === "restart" &&
      options.failRestart
    ) {
      options.failRestart = false;
      throw new Error("restart failed");
    }
    return { stdout: command === "curl" ? '{"ok":true}' : "" };
  };
  return { calls, run };
}

test("copies only service environment directives, preserving overrides and multiline quoting", () => {
  const environment = serviceEnvironment(`[Unit]
Environment=NOT_A_SERVICE_VALUE=1
[Service]
Environment="INLINE=two words"
EnvironmentFile=/etc/base.env
EnvironmentFile=-/etc/optional.env
ExecStart=/usr/bin/node server.js
# /etc/systemd/system/app.service.d/90-override.conf
[Service]
Environment=\
 "ANOTHER=value"
EnvironmentFile=
EnvironmentFile=/opt/ffmpeg/runtime.env
UnsetEnvironment=OLD_VALUE
`);

  assert.equal(
    environment,
    'Environment="INLINE=two words"\nEnvironmentFile=/etc/base.env\nEnvironmentFile=-/etc/optional.env\nEnvironment= "ANOTHER=value"\nEnvironmentFile=\nEnvironmentFile=/opt/ffmpeg/runtime.env\nUnsetEnvironment=OLD_VALUE',
  );
  assert.throws(
    () => serviceEnvironment("[Service]\nEnvironmentFile=/etc/%n.env"),
    /specifiers/,
  );
});

test("rejects unsupported platforms and unpinned or malformed downloads", () => {
  const manifest = {
    id: "ffmpeg-test",
    platform: "linux",
    architecture: "x64",
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-27/build.tar.xz",
    sha256: "a".repeat(64),
  };

  assert.equal(validateManifest(manifest, "linux", "x64"), manifest);
  assert.throws(
    () => validateManifest(manifest, "darwin", "arm64"),
    /Linux x64/,
  );
  assert.throws(
    () =>
      validateManifest(
        {
          ...manifest,
          url: manifest.url.replace("autobuild-2026-08-27", "latest"),
        },
        "linux",
        "x64",
      ),
    /Invalid/,
  );
  assert.throws(
    () =>
      validateManifest({ ...manifest, id: "../../elsewhere" }, "linux", "x64"),
    /Invalid/,
  );
});

function fakeDownload(bytes, calls) {
  return async (command, args) => {
    calls.push(command);
    if (command === "curl") {
      await writeFile(args[args.indexOf("--output") + 1], bytes);
    } else if (command === "tar") {
      const directory = args[args.indexOf("-C") + 1];
      await mkdir(path.join(directory, "bin"));
      await writeFile(path.join(directory, "bin/ffmpeg"), "verified ffmpeg");
      await writeFile(path.join(directory, "bin/ffprobe"), "verified ffprobe");
    }
    return { stdout: "" };
  };
}

test("refuses corrupt downloads before extracting or executing them and cleans staging", async (context) => {
  const paths = await fixture(context);
  const calls = [];
  const manifest = {
    id: "ffmpeg-test",
    url: "fixture",
    sha256: "a".repeat(64),
  };

  await assert.rejects(
    installFfmpeg(manifest, paths, fakeDownload("corrupt", calls)),
    /checksum mismatch/,
  );

  assert.deepEqual(calls, ["curl"]);
  assert.deepEqual(await readdir(paths.tools), []);
});

test("installs once, verifies reused binaries, and leaves the service configuration alone", async (context) => {
  const paths = await fixture(context);
  const calls = [];
  const bytes = "verified archive";
  const manifest = {
    id: "ffmpeg-test",
    url: "fixture",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const run = fakeDownload(bytes, calls);
  await writeFile(paths.override, "existing operator override");

  const target = await installFfmpeg(manifest, paths, run);
  const reused = await installFfmpeg(manifest, paths, run);

  assert.equal(reused, target);
  assert.equal(calls.filter((command) => command === "curl").length, 1);
  assert.equal(
    await readFile(paths.override, "utf8"),
    "existing operator override",
  );
  assert.equal(
    await readFile(path.join(target, "runtime.env"), "utf8"),
    `FFMPEG_BIN=${target}/bin/ffmpeg\n`,
  );
  await writeFile(path.join(target, "bin/ffmpeg"), "changed binary");
  await assert.rejects(
    installFfmpeg(manifest, paths, run),
    /checksum mismatch/,
  );
});

test("restores the exact old override when preactivation media verification fails", async (context) => {
  const paths = await fixture(context);
  const old = "[Service]\nEnvironmentFile=/opt/previous/runtime.env\n";
  await writeFile(paths.override, old, { mode: 0o640 });
  const { run, calls } = fakeService(paths, { failSmoke: true });

  await assert.rejects(
    selectFfmpeg("/opt/new-ffmpeg", "/opt/release", paths, run),
    /smoke test failed/,
  );

  assert.equal(await readFile(paths.override, "utf8"), old);
  assert.equal((await stat(paths.override)).mode & 0o777, 0o640);
  assert.equal(
    calls.some((call) => call[1] === "restart"),
    false,
  );
  assert.deepEqual(await readdir(paths.units), []);
  await assert.rejects(readFile(path.join(paths.state, "rollback.json")), {
    code: "ENOENT",
  });
});

test("restores configuration and restarts the original selection after startup failure", async (context) => {
  const paths = await fixture(context);
  await writeFile(
    paths.override,
    "[Service]\nEnvironmentFile=/opt/previous/runtime.env\n",
  );
  const { run, calls } = fakeService(paths, { failRestart: true });

  await assert.rejects(
    selectFfmpeg("/opt/new-ffmpeg", "/opt/release", paths, run),
    /restart failed/,
  );

  assert.equal(
    await readFile(paths.override, "utf8"),
    "[Service]\nEnvironmentFile=/opt/previous/runtime.env\n",
  );
  assert.equal(calls.filter((call) => call[1] === "restart").length, 2);
});

test("rolls back a new selection without deleting any binaries", async (context) => {
  const paths = await fixture(context);
  const { run, calls } = fakeService(paths);
  const target = path.join(paths.tools, "ffmpeg-test");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "retained-binary"), "binary");

  await selectFfmpeg(target, "/opt/release", paths, run);
  await rollbackFfmpeg(paths, run);

  await assert.rejects(readFile(paths.override), { code: "ENOENT" });
  assert.equal(
    await readFile(path.join(target, "retained-binary"), "utf8"),
    "binary",
  );
  assert.equal(calls.filter((call) => call[1] === "restart").length, 2);
});

test("rollback refuses later operator edits", async (context) => {
  const paths = await fixture(context);
  const { run, calls } = fakeService(paths);
  await selectFfmpeg("/opt/new-ffmpeg", "/opt/release", paths, run);
  await writeFile(paths.override, "operator changed this after activation");
  const before = calls.length;

  await assert.rejects(rollbackFfmpeg(paths, run), /later edits/);

  assert.equal(calls.length, before);
  assert.equal(
    await readFile(paths.override, "utf8"),
    "operator changed this after activation",
  );
});

test("runs preflight in the service environment and removes temporary units", async (context) => {
  const paths = await fixture(context);
  await writeFile(
    paths.override,
    "[Service]\nEnvironmentFile=/opt/existing/runtime.env\n",
  );
  const serviceRunner = fakeService(paths);
  let unit;
  const run = async (command, args) => {
    if (command === "systemctl" && args[0] === "start") {
      unit = await readFile(path.join(paths.units, args[1]), "utf8");
      assert.equal(
        (await stat(path.join(paths.units, args[1]))).mode & 0o777,
        0o600,
      );
    }
    return serviceRunner.run(command, args);
  };

  await checkServiceMedia("/opt/new-release", paths, run);

  assert.ok(
    unit.includes(
      "EnvironmentFile=/etc/podcast2article.env\nEnvironmentFile=/opt/existing/runtime.env",
    ),
  );
  assert.ok(unit.includes("WorkingDirectory=/opt/new-release"));
  assert.ok(unit.includes("User=podcast2article"));
  assert.deepEqual(await readdir(paths.units), []);
  assert.equal(
    serviceRunner.calls.some((call) => call[1] === "restart"),
    false,
  );
});

test("rechecks an unchanged selection without replacing its rollback history", async (context) => {
  const paths = await fixture(context);
  const { run, calls } = fakeService(paths);
  await selectFfmpeg("/opt/new-ffmpeg", "/opt/release", paths, run);
  const saved = await readFile(path.join(paths.state, "rollback.json"), "utf8");
  const before = calls.length;

  await selectFfmpeg("/opt/new-ffmpeg", "/opt/release", paths, run);

  assert.equal(
    await readFile(path.join(paths.state, "rollback.json"), "utf8"),
    saved,
  );
  assert.equal(
    calls.slice(before).filter((call) => call[1] === "start").length,
    1,
  );
  await rollbackFfmpeg(paths, run);
  await assert.rejects(readFile(paths.override), { code: "ENOENT" });
});

test("removes the temporary unit even when stopping it fails", async (context) => {
  const paths = await fixture(context);
  const serviceRunner = fakeService(paths);
  const run = async (command, args) => {
    if (command === "systemctl" && args[0] === "stop") {
      throw new Error("stop failed");
    }
    return serviceRunner.run(command, args);
  };

  await assert.rejects(
    checkServiceMedia("/opt/release", paths, run),
    /stop failed/,
  );

  assert.deepEqual(await readdir(paths.units), []);
});

test("refuses active, queued, unknown, or corrupt job state without exposing content", async (context) => {
  const paths = await fixture(context);
  const users = path.join(paths.tools, "test-users");
  await assertIdle(users);
  const jobs = path.join(users, "test-user", "jobs");
  await mkdir(jobs, { recursive: true });
  const filename = path.join(jobs, "fixture.json");
  for (const stage of [
    "queued",
    "downloading",
    "transcribing",
    "writing",
    "unknown",
  ]) {
    await writeFile(filename, JSON.stringify({ stage }));
    await assert.rejects(assertIdle(users), /Active or queued jobs/);
  }
  for (const stage of ["complete", "failed"]) {
    await writeFile(filename, JSON.stringify({ stage }));
    await assertIdle(users);
  }

  await writeFile(filename, '{"private transcript": broken JSON');

  await assert.rejects(assertIdle(users), (error) => {
    assert.match(error.message, /Could not verify stored job state/);
    assert.equal(error.message.includes("private transcript"), false);
    return true;
  });
});
