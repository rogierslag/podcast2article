import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeGitSha, resolveGitSha } from "./git.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("git SHA helpers", () => {
  it("normalizes a full git SHA", () => {
    expect(normalizeGitSha(` ${"A".repeat(40)}\n`)).toBe("a".repeat(40));
  });

  it("rejects missing, abbreviated, and malformed values", () => {
    expect(normalizeGitSha(undefined)).toBeUndefined();
    expect(normalizeGitSha("abc1234")).toBeUndefined();
    expect(normalizeGitSha("z".repeat(40))).toBeUndefined();
  });

  it("prefers an explicitly configured SHA", async () => {
    const configuredSha = "1".repeat(40);

    await expect(
      resolveGitSha({ environment: { GIT_SHA: configuredSha } }),
    ).resolves.toBe(configuredSha);
  });

  it("reads the production deployment marker", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "p2a-git-sha-"));
    temporaryDirectories.push(directory);
    const deployedSha = "2".repeat(40);
    await writeFile(path.join(directory, ".deployed-commit"), deployedSha);

    await expect(
      resolveGitSha({ environment: {}, repositoryDirectory: directory }),
    ).resolves.toBe(deployedSha);
  });
});
