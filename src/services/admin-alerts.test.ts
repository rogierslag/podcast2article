import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminAlertWorker,
  alertConfiguration,
  sesAlertSender,
} from "./admin-alerts.js";
import { collectAdminProblems, type AdminProblem } from "./admin-problems.js";

const config = {
  from: "reads@example.com",
  to: "admin@example.com",
  region: "us-east-1",
  origin: "https://reads.example.com",
};
const problem: AdminProblem = {
  key: "job/local/1",
  fingerprint: "attempt1",
  summary: "Job failed: Example",
  details: "Transcription failed",
  route: "/#job=1",
};
let root: string;
let now: number;
let problems: AdminProblem[];
const send = vi.fn(async () => undefined);
function worker() {
  return new AdminAlertWorker(
    path.join(root, "state.json"),
    async () => problems,
    send,
    config.origin,
    () => now,
  );
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "admin-alerts-"));
  now = Date.parse("2026-09-28T00:00:00Z");
  problems = [problem];
  send.mockReset();
  send.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("admin alerts", () => {
  it("is opt-in and requires complete, valid mail configuration", () => {
    expect(alertConfiguration({})).toBeUndefined();
    expect(() =>
      alertConfiguration({ ADMIN_ALERT_EMAIL: config.to }),
    ).toThrow();
    const env = {
      ADMIN_ALERT_EMAIL: config.to,
      SES_FROM_EMAIL: config.from,
      SES_REGION: config.region,
      PUBLIC_BASE_URL: config.origin,
    };
    expect(alertConfiguration(env)).toEqual(config);
    expect(() =>
      alertConfiguration({
        ...env,
        ADMIN_ALERT_EMAIL: "admin@example.com\nBcc: other@example.com",
      }),
    ).toThrow();
    expect(() =>
      alertConfiguration({
        ...env,
        PUBLIC_BASE_URL: "https://user:secret@example.com",
      }),
    ).toThrow();
  });

  it("sends plain text to exactly the configured recipient", async () => {
    const sdk = vi
      .spyOn(SESv2Client.prototype, "send")
      .mockResolvedValue({} as never);
    await sesAlertSender(config)({
      subject: "Reads: test",
      text: "Example problem\n",
    });
    const input = sdk.mock.calls[0]?.[0].input;
    expect(input).toEqual({
      FromEmailAddress: config.from,
      Destination: { ToAddresses: [config.to] },
      Content: {
        Simple: {
          Subject: { Data: "Reads: test", Charset: "UTF-8" },
          Body: { Text: { Data: "Example problem\n", Charset: "UTF-8" } },
        },
      },
    });
  });

  it("batches failures and remembers successful alerts after restarting", async () => {
    const first = worker();
    await first.flush();
    expect(send).not.toHaveBeenCalled();
    problems.push({
      ...problem,
      key: "job/local/2",
      summary: "Second problem",
    });
    now += 300_000;
    await Promise.all([first.flush(), first.flush()]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([
      {
        subject: "Reads: 2 problems need attention",
        text: expect.stringContaining("Second problem"),
      },
    ]);

    now += 300_000;
    await worker().flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries failed delivery after 15 minutes, including after restart", async () => {
    const first = worker();
    await first.flush();
    now += 300_000;
    send.mockRejectedValueOnce(new Error("SES unavailable"));
    await expect(first.flush()).rejects.toThrow("SES unavailable");
    now += 300_000;
    await worker().flush();
    expect(send).toHaveBeenCalledTimes(1);
    now += 600_000;
    await worker().flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("notifies again for a new attempt and after a series recovers and fails again", async () => {
    const first = worker();
    await first.flush();
    now += 300_000;
    await first.flush();
    problems = [{ ...problem, fingerprint: "attempt2" }];
    await first.flush();
    expect(send).toHaveBeenCalledTimes(1);
    now += 300_000;
    await first.flush();
    expect(send).toHaveBeenCalledTimes(2);
    problems = [];
    await first.flush();
    problems = [problem];
    now += 300_000;
    await first.flush();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not email problems resolved before the batch is sent", async () => {
    const first = worker();
    await first.flush();
    problems = [];
    now += 300_000;
    await first.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not replace corrupt receipts or send a flood of duplicate alerts", async () => {
    await writeFile(path.join(root, "state.json"), "broken");
    await expect(worker().flush()).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, "state.json"), "utf8")).toBe(
      "broken",
    );
  });

  it("limits each email to 20 problems and sends the rest in a later batch", async () => {
    problems = Array.from({ length: 21 }, (_, index) => ({
      ...problem,
      key: `job/${index}`,
    }));
    const first = worker();
    await first.flush();
    now += 300_000;
    await first.flush();
    expect(send.mock.calls[0]).toEqual([
      expect.objectContaining({ subject: "Reads: 20 problems need attention" }),
    ]);
    now += 300_000;
    await first.flush();
    expect(send.mock.calls[1]).toEqual([
      expect.objectContaining({ subject: "Reads: 1 problem needs attention" }),
    ]);
  });
});

it("collects failed jobs, series and deployments without exposing sensitive payloads", async () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const directory = path.join(root, "users", "local");
  await mkdir(path.join(directory, "jobs"), { recursive: true });
  await writeFile(
    path.join(directory, "jobs", `${id}.json`),
    JSON.stringify({
      id,
      stage: "failed",
      failedStage: "transcribing",
      updatedAt: "2026-09-28",
      error: "raw-secret-error",
      episode: { title: "An episode" },
      sourceUrl: "https://secret.example/?token=secret",
      transcript: ["private transcript"],
      shareToken: "private-share-token",
      apiUsage: {
        requests: [{ status: "failed", errorCode: "insufficient_quota" }],
      },
    }),
  );
  await writeFile(
    path.join(directory, "subscriptions.json"),
    JSON.stringify([{ id, title: "A series", error: "series.errorCheck" }]),
  );
  await writeFile(
    path.join(root, "deployment-status.json"),
    JSON.stringify({
      failed: true,
      targetCommit: "abc",
      rawError: "secret stack",
    }),
  );

  const found = await collectAdminProblems(root, ["local"]);

  expect(found).toHaveLength(3);
  expect(found[0]?.details).toContain("OpenAI credits or quota are exhausted");
  expect(found[0]?.details).toContain("Failed step: transcribing");
  expect(JSON.stringify(found)).not.toMatch(/secret|private transcript/);
  await expect(collectAdminProblems(root, ["../other"])).rejects.toThrow(
    "Invalid alert account",
  );
});

it("alerts on an unreadable scan without losing prior delivery receipts", async () => {
  const collect = vi.fn(async () => problems);
  const first = new AdminAlertWorker(
    path.join(root, "state.json"),
    collect,
    send,
    config.origin,
    () => now,
  );
  await first.flush();
  now += 300_000;
  await first.flush();
  collect.mockRejectedValueOnce(new Error("secret provider body"));
  now += 300_000;
  await first.flush();
  expect(send).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(send.mock.calls)).not.toContain("secret provider body");
  now += 300_000;
  await first.flush();
  expect(send).toHaveBeenCalledTimes(2);
});

it("excludes completed and deleted jobs, paused series and unrelated accounts", async () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const deletedId = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  for (const username of ["local", "other"]) {
    const directory = path.join(root, "users", username);
    await mkdir(path.join(directory, "jobs"), { recursive: true });
    await writeFile(
      path.join(directory, "jobs", `${id}.json`),
      JSON.stringify({
        id,
        stage: username === "local" ? "complete" : "failed",
        updatedAt: "2026-09-28",
      }),
    );
    await writeFile(
      path.join(directory, "jobs", `${deletedId}.json`),
      JSON.stringify({
        id: deletedId,
        stage: "failed",
        updatedAt: "2026-09-28",
        deletedAt: "2026-09-28",
      }),
    );
    await writeFile(
      path.join(directory, "subscriptions.json"),
      JSON.stringify([
        { id, title: "Paused", error: "series.errorCheck", paused: true },
      ]),
    );
  }
  await writeFile(
    path.join(root, "deployment-status.json"),
    JSON.stringify({ failed: false, targetCommit: null }),
  );

  expect(await collectAdminProblems(root, ["local"])).toEqual([]);
});

it("does not expose unknown stored errors and translates known failure codes", async () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const directory = path.join(root, "users", "local");
  await mkdir(path.join(directory, "jobs"), { recursive: true });
  const file = path.join(directory, "jobs", `${id}.json`);
  await writeFile(
    file,
    JSON.stringify({
      id,
      stage: "failed",
      updatedAt: "2026-09-28",
      error: "token=private-secret",
    }),
  );
  const generic = await collectAdminProblems(root, ["local"]);
  expect(generic[0]?.details).toContain("Check the server logs");
  expect(JSON.stringify(generic)).not.toContain("private-secret");
  await writeFile(
    file,
    JSON.stringify({
      id,
      stage: "failed",
      updatedAt: "2026-09-28",
      error: "error.drivePrivate",
    }),
  );
  const known = await collectAdminProblems(root, ["local"]);
  expect(known[0]?.details).toContain("Google Meet");
});
