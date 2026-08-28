import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const service = "podcast2article.service";

export function runtimePaths(root = "/") {
  const application = path.join(root, "opt/podcast2article");
  return {
    tools: path.join(application, "tools"),
    current: path.join(application, "current"),
    state: path.join(application, "ffmpeg-selection"),
    override: path.join(
      root,
      "etc/systemd/system/podcast2article.service.d/90-ffmpeg-override.conf",
    ),
    units: path.join(root, "run/systemd/system"),
  };
}

async function readOptional(filename) {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function atomicWrite(filename, content, mode = 0o600) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode, flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function digest(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function validateManifest(
  manifest,
  platform = process.platform,
  architecture = process.arch,
) {
  if (
    !manifest ||
    !/^ffmpeg-[a-zA-Z0-9.-]+$/.test(manifest.id ?? "") ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? "") ||
    !/^https:\/\/github\.com\/BtbN\/FFmpeg-Builds\/releases\/download\/autobuild-[\w-]+\/[\w.-]+\.tar\.xz$/.test(
      manifest.url ?? "",
    )
  ) {
    throw new Error("Invalid pinned FFmpeg manifest");
  }
  if (
    manifest.platform !== platform ||
    manifest.architecture !== architecture
  ) {
    throw new Error(
      "The pinned FFmpeg build supports Linux x64 only; provision other platforms explicitly",
    );
  }
  return manifest;
}

export async function installFfmpeg(manifest, paths, run = execute) {
  const target = path.join(paths.tools, manifest.id);
  const receiptPath = path.join(target, "receipt.json");
  const existing = await readOptional(receiptPath);
  if (existing !== null) {
    const receipt = JSON.parse(existing);
    if (
      receipt.sha256 !== manifest.sha256 ||
      receipt.ffmpeg !== (await digest(path.join(target, "bin/ffmpeg"))) ||
      receipt.ffprobe !== (await digest(path.join(target, "bin/ffprobe")))
    ) {
      throw new Error(
        "Installed FFmpeg checksum mismatch; refusing to reuse it",
      );
    }
    return target;
  }
  await mkdir(paths.tools, { recursive: true, mode: 0o755 });
  if (
    await stat(target).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    })
  ) {
    throw new Error(
      "FFmpeg destination exists without a receipt; refusing to overwrite it",
    );
  }
  // Stage on disk beside the destination, not in the VPS's small /tmp tmpfs.
  const staging = await mkdtemp(path.join(paths.tools, ".ffmpeg-install-"));
  try {
    const archive = path.join(staging, "archive.tar.xz");
    await run("curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-time",
      "180",
      "--retry",
      "2",
      "--output",
      archive,
      manifest.url,
    ]);
    if ((await digest(archive)) !== manifest.sha256) {
      throw new Error(
        "Downloaded FFmpeg checksum mismatch; archive was not executed or installed",
      );
    }
    const unpacked = path.join(staging, "unpacked");
    await mkdir(unpacked);
    await run("tar", [
      "-xJf",
      archive,
      "--strip-components=1",
      "--no-same-owner",
      "--no-same-permissions",
      "-C",
      unpacked,
    ]);
    for (const binary of ["ffmpeg", "ffprobe"]) {
      const executable = path.join(unpacked, "bin", binary);
      await chmod(executable, 0o755);
      await run(executable, ["-version"]);
    }
    await writeFile(
      path.join(unpacked, "receipt.json"),
      JSON.stringify(
        {
          ...manifest,
          ffmpeg: await digest(path.join(unpacked, "bin/ffmpeg")),
          ffprobe: await digest(path.join(unpacked, "bin/ffprobe")),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o644 },
    );
    await writeFile(
      path.join(unpacked, "runtime.env"),
      `FFMPEG_BIN=${target}/bin/ffmpeg\n`,
      { mode: 0o644 },
    );
    await chmod(unpacked, 0o755);
    await rename(unpacked, target);
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// Preserve systemd's own quoting and EnvironmentFile ordering. Never source
// environment files as shell code or print their contents in deployment logs.
export function serviceEnvironment(unitText) {
  const directives = [];
  let section = "";
  let continued = "";
  for (const raw of unitText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.endsWith("\\")) {
      continued += line.slice(0, -1) + " ";
      continue;
    }
    const logical = continued + line;
    continued = "";
    if (logical.startsWith("[")) {
      section = logical;
    } else if (
      section === "[Service]" &&
      /^(Environment|EnvironmentFile|PassEnvironment|UnsetEnvironment)\s*=/.test(
        logical,
      )
    ) {
      if (logical.replaceAll("%%", "").includes("%")) {
        throw new Error(
          "Media verification cannot safely copy unit-dependent environment specifiers",
        );
      }
      directives.push(logical);
    }
  }
  if (continued) {
    throw new Error("Incomplete systemd environment directive");
  }
  return directives.join("\n");
}

export async function checkServiceMedia(
  release,
  paths,
  run = execute,
  expectedFfmpeg = "",
) {
  const smoke = path.join(scriptDirectory, "media-smoke.mjs");
  for (const value of [release, smoke, expectedFfmpeg]) {
    if (value && !/^\/[a-zA-Z0-9_./-]+$/.test(value)) {
      throw new Error(
        "Media check paths must be absolute and contain no systemd expansions or whitespace",
      );
    }
  }
  const { stdout } = await run("systemctl", ["cat", service]);
  const environment = serviceEnvironment(stdout);
  const name = `podcast2article-media-check-${randomUUID()}.service`;
  const filename = path.join(paths.units, name);
  const unit = `[Unit]
Description=Podcast2Article media verification
[Service]
Type=oneshot
User=podcast2article
Group=podcast2article
WorkingDirectory=${release}
${environment}
ExecStart=/usr/bin/node ${smoke} ${release} ${expectedFfmpeg}
TimeoutStartSec=90
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
UMask=0077
`;
  await atomicWrite(filename, unit);
  try {
    await run("systemctl", ["daemon-reload"]);
    await run("systemctl", ["start", name]);
  } catch {
    throw new Error(
      "Production media smoke test failed; release was not activated. Check the configured FFmpeg installation",
    );
  } finally {
    try {
      await run("systemctl", ["stop", name]);
    } finally {
      await rm(filename, { force: true });
      await run("systemctl", ["daemon-reload"]);
      // reset-failed also returns nonzero for a successful, already unloaded unit.
      await run("systemctl", ["reset-failed", name]).catch(() => undefined);
    }
  }
}

async function restoreSelection(selection, paths, run) {
  if (selection.previous === null) {
    await rm(paths.override, { force: true });
  } else {
    await atomicWrite(
      paths.override,
      selection.previous,
      selection.previousMode,
    );
  }
  await run("systemctl", ["daemon-reload"]);
}

async function restartAndCheck(run) {
  await run("systemctl", ["restart", service]);
  // curl retries connection refusal while Express starts, without printing secrets.
  const { stdout } = await run("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--retry",
    "15",
    "--retry-connrefused",
    "--retry-delay",
    "1",
    "--max-time",
    "2",
    "http://127.0.0.1:3000/api/health",
  ]);
  if (JSON.parse(stdout).ok !== true) {
    throw new Error("Application health check failed");
  }
}

export async function selectFfmpeg(
  target,
  release,
  paths,
  run = execute,
  restart = true,
) {
  const selected = `[Service]\nEnvironmentFile=${target}/runtime.env\n`;
  const previous = await readOptional(paths.override);
  if (previous === selected) {
    if (release) {
      await checkServiceMedia(release, paths, run, `${target}/bin/ffmpeg`);
      if (restart) {
        await restartAndCheck(run);
      }
    }
    return;
  }
  const selection = {
    selected,
    previous,
    previousMode:
      previous === null ? 0o644 : (await stat(paths.override)).mode & 0o777,
  };
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  const backup = path.join(paths.state, `${Date.now()}-${randomUUID()}.json`);
  await atomicWrite(backup, JSON.stringify(selection));
  let restarting = false;
  try {
    await atomicWrite(paths.override, selected, 0o644);
    await run("systemctl", ["daemon-reload"]);
    if (release) {
      await checkServiceMedia(release, paths, run, `${target}/bin/ffmpeg`);
    }
    if (restart && release) {
      restarting = true;
      await restartAndCheck(run);
    }
    await atomicWrite(
      path.join(paths.state, "rollback.json"),
      JSON.stringify(selection),
    );
  } catch (error) {
    await restoreSelection(selection, paths, run);
    if (restarting) {
      await restartAndCheck(run);
    }
    throw error;
  }
}

export async function rollbackFfmpeg(paths, run = execute) {
  const saved = await readOptional(path.join(paths.state, "rollback.json"));
  if (saved === null) {
    throw new Error("No managed FFmpeg selection is available to roll back");
  }
  const selection = JSON.parse(saved);
  if ((await readOptional(paths.override)) !== selection.selected) {
    throw new Error(
      "FFmpeg override was changed; refusing to overwrite later edits",
    );
  }
  await restoreSelection(selection, paths, run);
  await restartAndCheck(run);
  await rename(
    path.join(paths.state, "rollback.json"),
    path.join(paths.state, `rolled-back-${randomUUID()}.json`),
  );
}

async function main() {
  if (process.getuid?.() !== 0 || process.platform !== "linux") {
    throw new Error(
      "Run FFmpeg provisioning with sudo on the Linux production host",
    );
  }
  const args = process.argv.slice(2);
  if (args[0] !== "--locked") {
    try {
      const result = await execute(
        "flock",
        [
          "--nonblock",
          "/run/lock/podcast2article-update.lock",
          process.execPath,
          fileURLToPath(import.meta.url),
          "--locked",
          ...args,
        ],
        { timeout: 600_000 },
      );
      process.stdout.write(result.stdout);
    } catch (error) {
      // This child is this same CLI, whose error boundary already removes raw
      // subprocess diagnostics. A flock failure also contains no environment.
      console.error(
        error.stderr?.trim() ||
          "Could not acquire the deployment lock or complete the FFmpeg operation",
      );
      process.exitCode = 1;
    }
    return;
  }
  const [, action, argument] = args;
  const paths = runtimePaths();
  if (action === "activate" || action === "rollback") {
    await assertIdle(path.join("/var/lib/podcast2article", "users"));
  }
  if (action === "check") {
    await checkServiceMedia(path.resolve(argument ?? paths.current), paths);
  } else if (action === "rollback") {
    await rollbackFfmpeg(paths);
  } else if (["install", "ensure", "activate"].includes(action)) {
    const manifest = validateManifest(
      JSON.parse(await readFile(argument, "utf8")),
    );
    const target = await installFfmpeg(manifest, paths);
    if (action !== "install") {
      if (
        action === "ensure" &&
        (await readOptional(paths.override)) !== null
      ) {
        console.log(
          "Existing FFmpeg override preserved; use activate to replace it explicitly.",
        );
        return;
      }
      const release = await stat(paths.current)
        .then(() => paths.current)
        .catch((error) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
          return null;
        });
      if (action === "activate") {
        // Downloads can take minutes; do not rely solely on the initial check.
        await assertIdle("/var/lib/podcast2article/users");
      }
      await selectFfmpeg(
        target,
        release,
        paths,
        execute,
        action === "activate",
      );
    }
  } else {
    throw new Error(
      "Usage: ffmpeg-runtime.mjs install|ensure|activate <manifest.json>, check <release>, or rollback",
    );
  }
  console.log("FFmpeg runtime operation completed successfully.");
}

export async function assertIdle(usersDirectory) {
  const users = await readdir(usersDirectory, { withFileTypes: true }).catch(
    (error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    },
  );
  for (const user of users.filter((entry) => entry.isDirectory())) {
    const jobsDirectory = path.join(usersDirectory, user.name, "jobs");
    const jobs = await readdir(jobsDirectory).catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    for (const filename of jobs.filter((name) => name.endsWith(".json"))) {
      const content = await readFile(
        path.join(jobsDirectory, filename),
        "utf8",
      );
      let job;
      try {
        job = JSON.parse(content);
      } catch {
        // JSON parser messages can contain excerpts from private job content.
        throw new Error(
          "Could not verify stored job state; refusing to switch FFmpeg",
        );
      }
      if (!["complete", "failed"].includes(job?.stage)) {
        throw new Error(
          "Active or queued jobs exist; wait before switching or rolling back FFmpeg",
        );
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    // execFile errors can include commands/environment values; expose only our messages.
    console.error(
      error.cmd
        ? "FFmpeg runtime command failed; configuration was not intentionally changed beyond the guarded operation."
        : error.message,
    );
    process.exitCode = 1;
  }
}
