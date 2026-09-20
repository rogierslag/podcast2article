import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export async function pauseForDeployment(directory, id, timeoutMs = 900_000) {
  const requestFile = path.join(directory, "deployment-drain.json");
  // Exclusive creation prevents overwriting another deployment's pause.
  await writeFile(requestFile, JSON.stringify({ id }), {
    flag: "wx",
    mode: 0o644,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = JSON.parse(
        await readFile(
          path.join(directory, "deployment-drain-status.json"),
          "utf8",
        ),
      );
      if (status.id === id && status.drained === true && status.active === 0) {
        return;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await delay(250);
  }
  throw new Error(
    "Deployment drain timed out; the running release must remain active",
  );
}

export async function resumeAfterDeployment(directory, id) {
  const requestFile = path.join(directory, "deployment-drain.json");
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    if (request.id !== id) {
      return;
    }
    await rm(requestFile);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [action, directory, id] = process.argv.slice(2);
  if (!directory || !id || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new Error(
      "Usage: deployment-drain.mjs pause|resume DATA_DIRECTORY UUID",
    );
  }
  if (action === "pause") {
    await pauseForDeployment(directory, id);
  } else if (action === "resume") {
    await resumeAfterDeployment(directory, id);
  } else {
    throw new Error("Unknown deployment drain action");
  }
}
