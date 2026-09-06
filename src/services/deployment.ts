import { readFile } from "node:fs/promises";
import path from "node:path";

export async function deploymentFailed(
  statusFile = path.resolve("data/deployment-status.json"),
): Promise<boolean> {
  try {
    const status: unknown = JSON.parse(await readFile(statusFile, "utf8"));
    return (
      typeof status === "object" &&
      status !== null &&
      "failed" in status &&
      status.failed === true
    );
  } catch {
    // An absent or unreadable marker is not evidence of a failed deployment.
    return false;
  }
}
