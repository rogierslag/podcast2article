import OpenAI from "openai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApiRequestUsage, BackgroundArticle } from "../types.js";
import * as apiUsage from "./api-usage.js";
import { requestBackgroundArticle } from "./background-article.js";
import { paidRequestDrain } from "./deployment-drain.js";

let saved: BackgroundArticle | undefined;
let records: ApiRequestUsage[];
let tiers: string[];
const payload = {
  model: "gpt-6.1-sol",
  input: "Test transcript",
  background: true,
  store: true,
  max_output_tokens: 100,
} satisfies OpenAI.Responses.ResponseCreateParamsNonStreaming;

beforeEach(() => {
  saved = undefined;
  records = [];
  tiers = [];
  vi.spyOn(apiUsage, "retryDelay").mockReturnValue(0);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected mock request");
    }),
  );
});

afterEach(() => {
  paidRequestDrain.resume();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function response(status: string, code?: string, id = "resp-test") {
  return new Response(
    JSON.stringify({
      id,
      object: "response",
      status,
      model: payload.model,
      service_tier: tiers.at(-1) ?? "flex",
      error: code ? { code, message: "Provider detail" } : null,
      incomplete_details:
        status === "incomplete" ? { reason: "max_output_tokens" } : null,
      output:
        status === "completed"
          ? [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "Article answer",
                    annotations: [],
                  },
                ],
              },
            ]
          : [],
      usage:
        status === "completed" ? { input_tokens: 10, output_tokens: 5 } : null,
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function run(signal?: AbortSignal, serviceTier: "flex" | "default" = "flex") {
  return requestBackgroundArticle(
    new OpenAI({ apiKey: "test-only" }),
    payload,
    {
      timeoutMs: 1000,
      serviceTier,
      signal,
      recordUsage: async (entry) => {
        records.push(structuredClone(entry));
      },
      checkpoint: {
        state: saved,
        requests: records,
        save: async (state) => {
          saved = structuredClone(state);
        },
      },
    },
  );
}

it("shares one attempt budget across HTTP and background failures before standard fallback", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      tiers.push(body.service_tier);
      if (tiers.length === 1) {
        return new Response(
          JSON.stringify({
            error: { code: "server_error", message: "Unavailable" },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      return response(
        tiers.length <= 3 ? "failed" : "completed",
        tiers.length <= 3 ? "server_error" : undefined,
      );
    }),
  );

  await expect(run()).resolves.toBe("Article answer");

  expect(tiers).toEqual(["flex", "flex", "flex", "default"]);
  const finished = records.filter((entry) => entry.status !== "pending");
  expect(finished.map((entry) => entry.attempt)).toEqual([1, 2, 3, 4]);
  expect(new Set(finished.map((entry) => entry.operationId)).size).toBe(1);
  expect(new Set(finished.map((entry) => entry.id)).size).toBe(4);
  expect(finished[1]).toMatchObject({
    httpStatus: 200,
    errorCode: "server_error",
    errorMessage: "Provider detail",
  });
});

it.each(["flex", "default"] as const)(
  "bounds terminal failures for %s processing",
  async (tier) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        tiers.push(JSON.parse(String(init?.body)).service_tier);
        return response("failed", "rate_limit_exceeded");
      }),
    );

    await expect(run(undefined, tier)).rejects.toThrow(
      "rate_limit_exceeded: Provider detail",
    );

    expect(tiers).toEqual(
      tier === "flex"
        ? ["flex", "flex", "flex", "default", "default", "default"]
        : ["default", "default", "default"],
    );
    expect(saved?.error).toEqual({
      code: "rate_limit_exceeded",
      message: "Provider detail",
    });
  },
);

it.each([
  ["failed", "insufficient_quota"],
  ["failed", "credit_balance_exhausted"],
  ["failed", "invalid_prompt"],
  ["failed", "data_residency_mismatch"],
  ["failed", undefined],
  ["cancelled", "server_error"],
  ["incomplete", undefined],
])("does not resubmit %s responses with error %s", async (status, code) => {
  const fetchMock = vi.fn(async () => response(status ?? "failed", code));
  vi.stubGlobal("fetch", fetchMock);

  await expect(run()).rejects.toThrow("Background article ended with status");

  expect(fetchMock).toHaveBeenCalledTimes(1);
  if (status === "incomplete") {
    expect(saved?.incompleteReason).toBe("max_output_tokens");
  }
});

it("resumes the persisted attempt budget and original tier after restart", async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      tiers.push(JSON.parse(String(init?.body)).service_tier);
      return response("failed", "server_error");
    }),
  );
  vi.mocked(apiUsage.retryDelay).mockImplementation((_error, attempt) => {
    if (attempt === 3) {
      controller.abort();
    }
    return 0;
  });

  await expect(run(controller.signal)).rejects.toThrow();
  expect(saved?.request.attempt).toBe(3);
  vi.mocked(apiUsage.retryDelay).mockReturnValue(0);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      tiers.push(body.service_tier);
      expect(body.model).toBe("gpt-6.1-sol");
      return response("completed");
    }),
  );

  await expect(run(undefined, "default")).resolves.toBe("Article answer");

  expect(tiers).toEqual(["flex", "flex", "flex", "default"]);
  expect(saved?.request).toMatchObject({
    attempt: 4,
    initialServiceTier: "flex",
  });
});

it("persists polled errors before retrying and reacquires deployment admission", async () => {
  let submissions = 0;
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      submissions += 1;
      tiers.push(JSON.parse(String(init.body)).service_tier);
      expect(paidRequestDrain.pending).toBe(1);
      return response(submissions === 1 ? "queued" : "completed");
    }
    expect(paidRequestDrain.pending).toBe(0);
    return response("failed", "server_error");
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(apiUsage.retryDelay).mockImplementation(() => {
    expect(saved?.error?.code).toBe("server_error");
    expect(records.at(-1)?.errorCode).toBe("server_error");
    expect(paidRequestDrain.pending).toBe(0);
    return 0;
  });

  await expect(run()).resolves.toBe("Article answer");

  expect(submissions).toBe(2);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(paidRequestDrain.pending).toBe(0);
});

it("does not submit again when a recovered response has exhausted its budget", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response("failed", "server_error")),
  );
  await expect(run()).rejects.toThrow();
  const last = saved;
  const fetchMock = vi.fn(async () => response("completed"));
  vi.stubGlobal("fetch", fetchMock);

  await expect(run()).rejects.toThrow("server_error");

  expect(fetchMock).not.toHaveBeenCalled();
  expect(saved).toEqual(last);
});

it("preserves HTTP retry attempts recorded after the last failed response on recovery", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response("failed", "server_error")),
  );
  await expect(run(undefined, "default")).rejects.toThrow();
  if (!saved) {
    throw new Error("Missing test checkpoint");
  }
  saved.request.attempt = 1;
  saved.request.initialServiceTier = "flex";
  const prior = structuredClone(saved.request);
  records = [
    {
      ...prior,
      id: "http-failure",
      attempt: 3,
      httpStatus: 503,
      errorCode: undefined,
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      tiers.push(JSON.parse(String(init?.body)).service_tier);
      return response("completed");
    }),
  );

  await expect(run()).resolves.toBe("Article answer");

  expect(tiers).toEqual(["default"]);
  expect(saved.request.attempt).toBe(4);
});

it("stops recovery when a replacement submission has an ambiguous outcome", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response("failed", "server_error")),
  );
  await expect(run(undefined, "default")).rejects.toThrow();
  if (!saved) {
    throw new Error("Missing test checkpoint");
  }
  saved.request.attempt = 1;
  records = [
    {
      ...saved.request,
      id: "ambiguous-submission",
      attempt: 2,
      status: "pending",
    },
  ];
  const fetchMock = vi.fn(async () => response("completed"));
  vi.stubGlobal("fetch", fetchMock);

  await expect(run()).rejects.toThrow("unknown provider outcome");

  expect(fetchMock).not.toHaveBeenCalled();
});

it("checks budget again before submitting a replacement", async () => {
  const fetchMock = vi.fn(async () => response("failed", "server_error"));
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    requestBackgroundArticle(new OpenAI({ apiKey: "test-only" }), payload, {
      serviceTier: "flex",
      timeoutMs: 1000,
      recordUsage: async (entry) => {
        if (entry.attempt === 2 && entry.status === "pending") {
          throw new Error("Budget exceeded");
        }
      },
    }),
  ).rejects.toThrow("Budget exceeded");

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(paidRequestDrain.pending).toBe(0);
});

it("stops if the failed response cannot be durably saved", async () => {
  const fetchMock = vi.fn(async () => response("failed", "server_error"));
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    requestBackgroundArticle(new OpenAI({ apiKey: "test-only" }), payload, {
      serviceTier: "flex",
      timeoutMs: 1000,
      checkpoint: {
        save: async () => {
          throw new Error("Storage failed");
        },
      },
    }),
  ).rejects.toThrow("Storage failed");

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(paidRequestDrain.pending).toBe(0);
});

it.each([
  "insufficient_quota",
  "credit_balance_exhausted",
  "project_spend_limit_exceeded",
])("does not retry HTTP 429 billing error %s", async (code) => {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ error: { code, message: "Billing limit" } }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "x-should-retry": "true",
          },
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(run()).rejects.toThrow("Billing limit");

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(records.at(-1)?.errorCode).toBe(code);
});

it("stops polling on quota exhaustion without replacing the pending generation", async () => {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    return init?.method === "POST"
      ? response("queued")
      : new Response(
          JSON.stringify({
            error: {
              code: "insufficient_quota",
              message: "Credits exhausted",
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(run()).rejects.toThrow("Credits exhausted");

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(saved?.status).toBe("queued");
});
