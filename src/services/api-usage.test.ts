import { afterEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import {
  endpointRegion,
  estimateApiCost,
  trackedRequest,
  usageMetrics,
} from "./api-usage.js";
import type { ApiRequestUsage } from "../types.js";

function request(patch: Partial<ApiRequestUsage> = {}): ApiRequestUsage {
  return {
    id: "attempt",
    operationId: "operation",
    attempt: 1,
    stage: "article",
    requestedModel: "gpt-5.6-terra",
    requestedServiceTier: "auto",
    actualServiceTier: "default",
    endpointRegion: "global",
    startedAt: "2026-09-15T10:00:00Z",
    status: "succeeded",
    cost: { currency: "USD", amount: null },
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
      output_tokens: 500,
      output_tokens_details: { reasoning_tokens: 300 },
    },
    ...patch,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("saved pricing estimates", () => {
  it("prices cached input, cache writes and output without double-counting reasoning", () => {
    const estimate = estimateApiCost(request());

    expect(estimate.amount).toBeCloseTo(0.00769, 10);
    expect(estimate).toMatchObject({
      currency: "USD",
      basis: "reported_tokens",
      pricingDate: "2026-09-19",
      rates: { inputPerMillion: 2 },
    });
  });

  it("prices Sol usage from the production job including cache writes", () => {
    const estimate = estimateApiCost(
      request({
        actualModel: "gpt-5.6-sol",
        usage: {
          input_tokens: 22965,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 22962 },
          output_tokens: 3901,
          output_tokens_details: { reasoning_tokens: 512 },
        },
      }),
    );

    expect(estimate.amount).toBeCloseTo(0.192842, 10);
    expect(estimate.rates).toMatchObject({
      inputPerMillion: 4,
      cachedInputPerMillion: 0.4,
      cacheWritePerMillion: 5,
      outputPerMillion: 20,
    });
  });

  it.each([
    ["default", 1],
    ["flex", 0.5],
    ["priority", 2],
    ["fast", 2],
  ])(
    "prices Sol cached tokens with the %s tier and regional uplift",
    (tier, multiplier) => {
      const estimate = estimateApiCost(
        request({
          requestedModel: "gpt-5.6-sol",
          actualServiceTier: tier,
          endpointRegion: "eu",
        }),
      );

      expect(estimate.amount).toBeCloseTo(0.01338 * multiplier * 1.1, 10);
    },
  );

  it.each([272000, 272001])(
    "uses Sol long-context prices only above 272K input tokens (%i)",
    (input) => {
      const estimate = estimateApiCost(
        request({
          requestedModel: "gpt-5.6-sol",
          usage: { input_tokens: input, output_tokens: 1000 },
        }),
      );

      const expected = input === 272000 ? 1.108 : 2.206008;
      expect(estimate.amount).toBeCloseTo(expected, 10);
    },
  );

  it("uses actual tier, long context prices and regional processing uplift", () => {
    const estimate = estimateApiCost(
      request({
        actualServiceTier: "flex",
        endpointRegion: "eu",
        usage: { input_tokens: 300000, output_tokens: 1000 },
      }),
    );

    expect(estimate.amount).toBeCloseTo(
      ((300000 * 2 + 1000 * 9) / 1e6) * 1.1,
      10,
    );
  });

  it("estimates short final chunks from reported seconds without rounding to minutes", () => {
    const estimate = estimateApiCost(
      request({
        stage: "transcription",
        requestedModel: "gpt-4o-transcribe-diarize",
        audioSeconds: 12.5,
      }),
    );

    expect(estimate.amount).toBeCloseTo(0.00125, 10);
    expect(estimate.basis).toBe("reported_duration");
  });

  it.each([
    { status: "failed" as const },
    { status: "pending" as const },
    { actualModel: "unpriced-model" },
    { endpointRegion: "custom" as const },
    { actualServiceTier: undefined },
    { usage: undefined },
    {
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 50 },
      },
    },
  ])("keeps unknown costs explicit: %j", (patch) => {
    expect(estimateApiCost(request(patch)).amount).toBeNull();
  });

  it("retains numeric usage details without response content", () => {
    expect(
      usageMetrics({
        input_tokens: 10,
        secret: "private",
        invalid: -1,
        output_tokens_details: { reasoning_tokens: 4 },
      }),
    ).toEqual({
      input_tokens: 10,
      output_tokens_details: { reasoning_tokens: 4 },
    });
    expect(endpointRegion("https://eu.api.openai.com/v1")).toBe("eu");
    expect(endpointRegion("https://example.com/v1")).toBe("custom");
  });
});

describe("API attempt accounting", () => {
  it("records failed retries separately and saves successful usage", async () => {
    const records: ApiRequestUsage[] = [];
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        new OpenAI.APIError(
          429,
          { code: "rate_limit_exceeded" },
          "limited",
          new Headers({ "retry-after": "0.001", "x-request-id": "req-failed" }),
        ),
      )
      .mockResolvedValue({
        data: {
          model: "gpt-5.6-terra",
          service_tier: "default",
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
        response: new Response(),
        request_id: "req-success",
      });

    await trackedRequest(
      {
        stage: "article",
        model: "gpt-5.6-terra",
        region: "global",
        record: async (entry) => {
          records.push(structuredClone(entry));
        },
      },
      send,
    );

    expect(records.map((entry) => entry.status)).toEqual([
      "pending",
      "failed",
      "pending",
      "succeeded",
    ]);
    expect(records[1]).toMatchObject({
      httpStatus: 429,
      requestId: "req-failed",
      cost: { amount: null },
    });
    expect(records[3]).toMatchObject({
      attempt: 2,
      requestId: "req-success",
      cost: { amount: 0.008 },
    });
    expect(records[0]?.operationId).toBe(records[3]?.operationId);
    expect(records[0]?.id).not.toBe(records[3]?.id);
  });

  it("does not send a request if saving its pending record fails", async () => {
    const send = vi.fn();

    await expect(
      trackedRequest(
        {
          stage: "article",
          model: "gpt-5.6-terra",
          region: "global",
          record: async () => {
            throw new Error("disk full");
          },
        },
        send,
      ),
    ).rejects.toThrow("disk full");

    expect(send).not.toHaveBeenCalled();
  });

  it("records cancellation without retrying or claiming a zero cost", async () => {
    const controller = new AbortController();
    const records: ApiRequestUsage[] = [];
    const send = vi.fn(async () => {
      controller.abort();
      throw new Error("aborted");
    });

    await expect(
      trackedRequest(
        {
          stage: "transcription",
          model: "gpt-4o-transcribe-diarize",
          region: "global",
          signal: controller.signal,
          record: async (entry) => {
            records.push(structuredClone(entry));
          },
        },
        send,
      ),
    ).rejects.toThrow("aborted");

    expect(send).toHaveBeenCalledTimes(1);
    expect(records[1]).toMatchObject({
      status: "aborted",
      cost: { amount: null },
    });
  });
});

it("checks budget again before an automatic provider retry", async () => {
  const send = vi
    .fn()
    .mockRejectedValue(
      new OpenAI.APIError(
        500,
        {},
        "unknown outcome",
        new Headers({ "retry-after": "0.001" }),
      ),
    );
  const records: ApiRequestUsage[] = [];

  await expect(
    trackedRequest(
      {
        stage: "article",
        model: "gpt-5.6-terra",
        region: "global",
        reservedCostUsd: 3,
        record: async (entry) => {
          if (entry.status === "pending" && entry.attempt === 2) {
            throw new Error("error.accountBudget");
          }
          records.push(structuredClone(entry));
        },
      },
      send,
    ),
  ).rejects.toThrow("error.accountBudget");

  expect(send).toHaveBeenCalledTimes(1);
  expect(records.map((entry) => entry.status)).toEqual(["pending", "failed"]);
  expect(records[1]?.reservedCostUsd).toBe(3);
});

it("falls back after three connection timeouts and retains unknown costs", async () => {
  const records: ApiRequestUsage[] = [];
  const send = vi
    .fn()
    .mockRejectedValueOnce(new OpenAI.APIConnectionTimeoutError())
    .mockRejectedValueOnce(new OpenAI.APIConnectionTimeoutError())
    .mockRejectedValueOnce(new OpenAI.APIConnectionTimeoutError())
    .mockResolvedValue({
      data: {
        service_tier: "default",
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
      response: new Response(),
      request_id: "fallback",
    });

  await trackedRequest(
    {
      stage: "article",
      model: "gpt-5.6-terra",
      region: "global",
      serviceTier: "flex",
      record: async (entry) => {
        records.push(structuredClone(entry));
      },
    },
    send,
  );

  expect(send.mock.calls.map(([tier]) => tier)).toEqual([
    "flex",
    "flex",
    "flex",
    "default",
  ]);
  expect(
    records
      .filter((entry) => entry.status === "failed")
      .every((entry) => entry.cost.amount === null),
  ).toBe(true);
  expect(records.at(-1)).toMatchObject({
    attempt: 4,
    requestedServiceTier: "default",
    actualServiceTier: "default",
    cost: { amount: 0.008 },
  });
});
