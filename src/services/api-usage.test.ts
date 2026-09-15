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
      pricingDate: "2026-09-15",
      rates: { inputPerMillion: 2 },
    });
  });

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
