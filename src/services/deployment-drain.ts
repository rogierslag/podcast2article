import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Admission closes before acknowledging a drain; leases include result persistence. */
export class RequestDrain {
  private paused = false;
  private active = 0;

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  get pending(): number {
    return this.active;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    while (this.paused) {
      await delay(100, undefined, { signal });
    }
    signal?.throwIfAborted();
    this.active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active -= 1;
      }
    };
  }
}

// Background article submissions are included until their response IDs are durable.
// Polling an existing response never holds this gate.
export const paidRequestDrain = new RequestDrain();

export async function startDeploymentDrain(
  directory = path.resolve("data"),
  gate = paidRequestDrain,
): Promise<() => Promise<void>> {
  const requestFile = path.join(directory, "deployment-drain.json");
  const statusFile = path.join(directory, "deployment-drain-status.json");
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<void> = Promise.resolve();

  const refresh = async () => {
    let request: unknown;
    try {
      request = JSON.parse(await readFile(requestFile, "utf8"));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        gate.resume();
        return;
      }
      gate.pause();
      throw error;
    }
    gate.pause();
    if (
      typeof request !== "object" ||
      request === null ||
      !("id" in request) ||
      typeof request.id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(request.id)
    ) {
      throw new Error("Invalid deployment drain request");
    }
    const status = {
      id: request.id,
      active: gate.pending,
      drained: gate.pending === 0,
    };
    await writeFile(`${statusFile}.tmp`, JSON.stringify(status));
    await rename(`${statusFile}.tmp`, statusFile);
  };
  await refresh();
  const schedule = () => {
    timer = setTimeout(() => {
      refreshing = refresh()
        .catch((error) =>
          console.error("Deployment drain refresh failed", error),
        )
        .finally(() => {
          if (!stopped) {
            schedule();
          }
        });
    }, 250);
    timer.unref();
  };
  schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await refreshing;
  };
}
