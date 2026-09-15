import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { articleFixture, articleId, password } from "./fixture.mjs";

// A disposable application root keeps browser mutations away from user data.
const root = await mkdtemp(path.join(tmpdir(), ".p2a-browser-"));
let child;
async function cleanup() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await cleanup();
    process.exit(0);
  });
}
try {
  await cp("public", path.join(root, "public"), { recursive: true });
  await cp("dist", path.join(root, "dist"), { recursive: true });
  await cp("package.json", path.join(root, "package.json"));
  await symlink(
    path.resolve("node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  const jobs = path.join(root, "data/users/regression/jobs");
  await mkdir(jobs, { recursive: true });
  await writeFile(
    path.join(jobs, `${articleId}.json`),
    JSON.stringify(articleFixture()),
  );
  child = spawn(process.execPath, ["dist/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "4317",
      APP_PASSWORD: "",
      APP_USERS: JSON.stringify({ regression: password }),
      OPENAI_API_KEY: "",
      PUBLIC_BASE_URL: "",
    },
    stdio: "inherit",
  });
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} finally {
  await cleanup();
}
