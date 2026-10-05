import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { buildClient } from "./build-client.mjs";

await buildClient();
let server;
let rebuilding = false;
let pending = false;
let needsClientBuild = false;
let stopping = false;
let timer;

function closeWatchers() {
  clearTimeout(timer);
  watchers.forEach((watcher) => watcher.close());
}

function startServer() {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    stdio: "inherit",
  });
  server = child;
  child.once("exit", (code) => {
    if (server !== child) {
      return;
    }
    server = undefined;
    console.error(
      `Development server exited (${code ?? "signal"}); waiting for source changes.`,
    );
  });
}

async function stopServer(signal = "SIGTERM") {
  const child = server;
  server = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
}

async function reload() {
  if (rebuilding || stopping) {
    return;
  }
  rebuilding = true;
  try {
    while (pending && !stopping) {
      pending = false;
      // Stop serving the old manifest before the build replaces its assets.
      await stopServer();
      if (needsClientBuild) {
        needsClientBuild = false;
        try {
          await buildClient();
        } catch (error) {
          needsClientBuild = true;
          console.error("Client build failed", error);
          continue;
        }
      }
      if (!stopping && !pending) {
        startServer();
      }
    }
  } finally {
    rebuilding = false;
  }
}

function scheduleReload(rebuildClient) {
  pending = true;
  needsClientBuild ||= rebuildClient;
  clearTimeout(timer);
  timer = setTimeout(() => void reload(), 100);
}

const watchers = [
  watch("public", { recursive: true }, () => scheduleReload(true)),
  watch("src", { recursive: true }, (_event, filename) => {
    const changed = filename?.toString().replaceAll("\\", "/");
    scheduleReload(
      !changed || changed === "shared" || changed.startsWith("shared/"),
    );
  }),
];
startServer();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    closeWatchers();
    void stopServer(signal);
  });
}
