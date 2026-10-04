import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { buildClient } from "./build-client.mjs";

await buildClient();
let building = false;
let pending = false;
let timer;
async function rebuild() {
  pending = true;
  if (building) {
    return;
  }
  building = true;
  try {
    while (pending) {
      pending = false;
      try {
        await buildClient();
      } catch (error) {
        console.error("Client build failed", error);
      }
    }
  } finally {
    building = false;
  }
}
const watchers = ["public", "src/shared"].map((directory) =>
  watch(directory, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 100);
  }),
);
const server = spawn(
  process.execPath,
  ["--import", "tsx", "--watch", "src/server.ts"],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    clearTimeout(timer);
    watchers.forEach((watcher) => watcher.close());
    server.kill(signal);
  });
}
server.once("exit", (code) => {
  watchers.forEach((watcher) => watcher.close());
  process.exitCode = code ?? 1;
});
