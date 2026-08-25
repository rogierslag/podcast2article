import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const fullGitShaPattern = /^[0-9a-f]{40}$/i;

interface GitShaOptions {
  environment?: NodeJS.ProcessEnv;
  repositoryDirectory?: string;
}

export function normalizeGitSha(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && fullGitShaPattern.test(normalized)
    ? normalized.toLowerCase()
    : undefined;
}

export async function resolveGitSha(
  options: GitShaOptions = {},
): Promise<string | undefined> {
  const environment = options.environment ?? process.env;
  const repositoryDirectory = options.repositoryDirectory ?? process.cwd();
  const environmentSha = normalizeGitSha(
    environment.GIT_SHA ?? environment.GITHUB_SHA,
  );
  if (environmentSha) {
    return environmentSha;
  }

  try {
    const deployedSha = normalizeGitSha(
      await readFile(
        path.join(repositoryDirectory, ".deployed-commit"),
        "utf8",
      ),
    );
    if (deployedSha) {
      return deployedSha;
    }
  } catch {
    // Local checkouts do not have the production deployment marker.
  }

  try {
    const { stdout } = await executeFile("git", ["rev-parse", "HEAD"], {
      cwd: repositoryDirectory,
    });
    return normalizeGitSha(stdout);
  } catch {
    return undefined;
  }
}
