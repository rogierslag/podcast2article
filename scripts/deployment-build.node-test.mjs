import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const updater = await readFile("scripts/update-production.sh", "utf8");
const buildStart = updater.indexOf(
  'corepack yarn --cwd "$build_directory" install',
);
const buildEnd = updater.indexOf("rsync -rlpt", buildStart);
assert.ok(buildStart > 0 && buildEnd > buildStart);
const buildStep = updater.slice(buildStart, buildEnd);

for (const buildExit of [0, 25]) {
  test(`deployment prepares a release only after a successful build (${buildExit})`, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "p2a-deployment-build-"),
    );
    const commands = path.join(directory, "commands.txt");
    const release = path.join(directory, "release");
    const script = `
set -e
build_directory="$1"
new_release="$2"
commands="$3"
build_exit="$4"
corepack() {
  printf '%s\\n' "$*" >> "$commands"
  case "$*" in
    *" run build") return "$build_exit" ;;
  esac
}
install() { mkdir -p "$new_release"; }
${buildStep}
`;
    try {
      const exitCode = await run("bash", [
        "-c",
        script,
        "test",
        directory,
        release,
        commands,
        String(buildExit),
      ]).then(
        () => 0,
        (error) => error.code,
      );

      assert.equal(exitCode, buildExit);
      assert.deepEqual((await readFile(commands, "utf8")).trim().split("\n"), [
        `yarn --cwd ${directory} install --frozen-lockfile --non-interactive`,
        `yarn --cwd ${directory} run build`,
      ]);
      const releaseExists = await stat(release).then(
        () => true,
        (error) => {
          assert.equal(error.code, "ENOENT");
          return false;
        },
      );
      assert.equal(releaseExists, buildExit === 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
