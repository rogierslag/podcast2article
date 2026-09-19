import { describe, expect, it } from "vitest";
import type { ApiRequestUsage, Job } from "../types.js";
import {
  accountSpend,
  assertAccountBudget,
  budgetWindowMs,
} from "./account-budget.js";
import { reserveApiCost } from "./api-usage.js";

const now = Date.parse("2026-09-19T12:00:00Z");
function request(
  amount: number | null,
  patch: Partial<ApiRequestUsage> = {},
): ApiRequestUsage {
  return {
    reservedCostUsd: 1,
    id: "request",
    operationId: "operation",
    attempt: 1,
    stage: "article",
    requestedModel: "gpt-5.6-terra",
    requestedServiceTier: "auto",
    endpointRegion: "global",
    status: "succeeded",
    startedAt: new Date(now - 1000).toISOString(),
    cost: { currency: "USD", amount },
    ...patch,
  };
}
function job(requests: ApiRequestUsage[], patch: Partial<Job> = {}): Job {
  return {
    id: "test",
    sourceUrl: "https://example.com/audio",
    language: "en",
    articleLength: "standard",
    stage: "complete",
    progress: 100,
    message: "Done",
    createdAt: new Date(now - 90 * 86400000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    apiUsage: {
      coverage: "complete",
      trackingStartedAt: new Date(now).toISOString(),
      knownEstimatedCostUsd: 0,
      unknownCostRequests: 0,
      requests,
    },
    ...patch,
  };
}

describe("rolling account budget", () => {
  it("uses request times including recent retries of old, failed and deleted jobs", () => {
    const jobs = [
      job([request(2)], { stage: "failed" }),
      job([request(3)], { deletedAt: new Date(now).toISOString() }),
    ];

    expect(accountSpend(jobs, now)).toBe(5);
    expect(() => assertAccountBudget(jobs, 0, now)).toThrow(
      "error.accountBudget",
    );
  });

  it("releases charges exactly 30 days later without a calendar-month reset", () => {
    const startedAt = new Date(now - budgetWindowMs).toISOString();
    const jobs = [job([request(5, { startedAt })])];

    expect(() => assertAccountBudget(jobs, 0, now - 1)).toThrow();
    expect(accountSpend(jobs, now)).toBe(0);
    expect(() => assertAccountBudget(jobs, 5, now)).not.toThrow();
  });

  it("uses completion time when a request crosses the window boundary", () => {
    expect(
      accountSpend(
        [
          job([
            request(5, {
              startedAt: new Date(now - budgetWindowMs - 1000).toISOString(),
              finishedAt: new Date(now - budgetWindowMs + 1000).toISOString(),
            }),
          ]),
        ],
        now,
      ),
    ).toBe(5);
  });

  it("reserves in-flight and uncertain requests and releases only confirmed savings", () => {
    for (const status of [
      "pending",
      "failed",
      "aborted",
      "succeeded",
    ] as const) {
      const jobs = [
        job([request(4), request(null, { status, reservedCostUsd: 0.75 })]),
      ];
      expect(() => assertAccountBudget(jobs, 0.26, now)).toThrow();
      expect(() => assertAccountBudget(jobs, 0.25, now)).not.toThrow();
    }
    expect(
      accountSpend([job([request(0.1, { reservedCostUsd: 0.75 })])], now),
    ).toBe(0.1);
  });

  it("treats all historical spending and missing coverage as free", () => {
    expect(
      accountSpend([job([request(50, { reservedCostUsd: undefined })])], now),
    ).toBe(0);
    expect(
      accountSpend([job([request(null, { reservedCostUsd: undefined })])], now),
    ).toBe(0);
    expect(accountSpend([job([], { apiUsage: undefined })], now)).toBe(0);
    expect(
      accountSpend([job([request(5)], { savedShareKey: "saved" })], now),
    ).toBe(0);
  });

  it("counts new reservations even when a legacy job has partial coverage", () => {
    const legacy = job([
      request(50, { reservedCostUsd: undefined }),
      request(null, { reservedCostUsd: 3 }),
    ]);
    if (legacy.apiUsage) {
      legacy.apiUsage.coverage = "partial";
    }

    expect(accountSpend([legacy], now)).toBe(3);
    expect(() => assertAccountBudget([legacy], 3, now)).toThrow();
  });

  it("expires abandoned reservations and rejects invalid or oversized allowances", () => {
    expect(
      accountSpend(
        [
          job([
            request(null, {
              status: "pending",
              reservedCostUsd: 2,
              startedAt: new Date(now - budgetWindowMs).toISOString(),
            }),
          ]),
        ],
        now,
      ),
    ).toBe(0);
    for (const reservation of [NaN, Infinity, -1, 5.01]) {
      expect(() => assertAccountBudget([], reservation, now)).toThrow();
    }
  });

  it("only reserves known models and endpoints with bounded output", () => {
    expect(
      reserveApiCost("unknown", "global", {
        inputBytes: 100,
        outputTokens: 100,
      }),
    ).toBeUndefined();
    expect(
      reserveApiCost("gpt-5.6-terra", "custom", {
        inputBytes: 100,
        outputTokens: 100,
      }),
    ).toBeUndefined();
    expect(
      reserveApiCost("gpt-5.6-sol", "eu", {
        inputBytes: 1000,
        outputTokens: 16384,
      }),
    ).toBeGreaterThan(1);
    expect(
      reserveApiCost("gpt-4o-transcribe-diarize", "eu", { audioSeconds: 601 }),
    ).toBeGreaterThan(0.06);
  });
});
