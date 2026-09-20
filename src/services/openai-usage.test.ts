import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { transcribeChunks, writeArticle } from "./openai.js";
import type { ApiRequestUsage } from "../types.js";

let directory: string;
let audio: string;
let records: ApiRequestUsage[];
const record = async (entry: ApiRequestUsage) => {
  records.push(structuredClone(entry));
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "p2a-usage-"));
  audio = path.join(directory, "test-only.mp3");
  await writeFile(audio, "mock audio");
  records = [];
  vi.stubEnv("OPENAI_API_KEY", "sk-test-only");
  vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
  vi.stubEnv("TRANSCRIPTION_MODEL", "gpt-4o-transcribe-diarize");
  vi.stubEnv("ARTICLE_MODEL", "gpt-5.6-terra");
  vi.stubEnv("ARTICLE_SERVICE_TIER", "");
  // No network traffic: even unexpected SDK requests fail locally.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected mock request");
    }),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

it("captures each chunk's actual duration, counters and request ID through the SDK", async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          text: "Hello",
          duration: 12.5,
          usage: { type: "duration", seconds: 12.5 },
          segments: [{ start: 0, end: 10, text: "Hello", speaker: "Alice" }],
        }),
        {
          headers: {
            "content-type": "application/json",
            "x-request-id": "req-transcription",
          },
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const transcript = await transcribeChunks(
    [audio, audio],
    "auto",
    () => {},
    () => {},
    undefined,
    record,
  );

  expect(transcript).toHaveLength(2);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(
    records
      .filter((entry) => entry.status === "succeeded")
      .map((entry) => entry.chunkNumber),
  ).toEqual([1, 2]);
  expect(records[1]).toMatchObject({
    requestId: "req-transcription",
    audioSeconds: 12.5,
    usage: { seconds: 12.5 },
    cost: { amount: 0.00125 },
  });
});

it("saves article usage before rejecting invalid generated JSON", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "resp-test",
            object: "response",
            status: "completed",
            model: "gpt-5.6-terra",
            service_tier: "default",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: "not JSON", annotations: [] },
                ],
              },
            ],
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              input_tokens_details: { cached_tokens: 200 },
              output_tokens_details: { reasoning_tokens: 300 },
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "x-request-id": "req-article",
            },
          },
        ),
    ),
  );

  await expect(
    writeArticle(
      [{ id: "t-00001", start: 0, end: 1, text: "Hello", speaker: "Alice" }],
      {
        title: "Test",
        sourceName: "Test",
        language: "auto",
        length: "standard",
      },
      () => {},
      undefined,
      record,
    ),
  ).rejects.toThrow();

  expect(records).toHaveLength(2);
  expect(records[0]?.reservedCostUsd).toBeGreaterThan(0);
  const calls = vi.mocked(fetch).mock.calls;
  const body = calls[0]?.[1]?.body;
  expect(typeof body).toBe("string");
  if (typeof body === "string") {
    expect(JSON.parse(body).max_output_tokens).toBe(16_384);
  }
  expect(records[1]).toMatchObject({
    stage: "article",
    status: "succeeded",
    actualModel: "gpt-5.6-terra",
    actualServiceTier: "default",
    requestId: "req-article",
    cost: { amount: 0.00764 },
  });
});

const articleFixture = {
  title: "Hello",
  dek: "An introduction",
  readingTimeMinutes: 1,
  styleNote: "Direct",
  sections: [
    {
      heading: "Introduction",
      paragraphs: [{ text: "Hello", sources: ["t-00001"] }],
    },
  ],
  takeaways: [{ text: "Hello", sources: ["t-00001"] }],
};

function generateArticle(signal?: AbortSignal) {
  return writeArticle(
    [{ id: "t-00001", start: 0, end: 1, text: "Hello", speaker: "Alice" }],
    { title: "Test", sourceName: "Test", language: "auto", length: "standard" },
    () => {},
    signal,
    record,
  );
}

function articleResponse(tier: string) {
  return new Response(
    JSON.stringify({
      id: "resp-flex-test",
      object: "response",
      status: "completed",
      model: "gpt-5.6-terra",
      service_tier: tier,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(articleFixture),
              annotations: [],
            },
          ],
        },
      ],
      usage: { input_tokens: 1000, output_tokens: 500 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function providerError(status = 429, retry = "true") {
  return new Response(
    JSON.stringify({
      error: {
        message: "Unavailable",
        code: "resource_unavailable",
        type: "server_error",
      },
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "retry-after": "0.001",
        "x-should-retry": retry,
      },
    },
  );
}

function mockArticleFetch(failures: number, status = 429) {
  const tiers: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      tiers.push(body.service_tier);
      return tiers.length <= failures
        ? providerError(status)
        : articleResponse(body.service_tier);
    }),
  );
  return tiers;
}

it.each([0, 1, 2, 3, 4, 5])(
  "uses Flex by default and falls back only after three failures (%i failures)",
  async (failures) => {
    const tiers = mockArticleFetch(failures);

    const result = await generateArticle();

    expect(result.title).toBe("Hello");
    expect(tiers).toEqual(
      Array.from({ length: failures + 1 }, (_, index) =>
        index < 3 ? "flex" : "default",
      ),
    );
    const completed = records.filter((entry) => entry.status !== "pending");
    expect(completed.map((entry) => entry.requestedServiceTier)).toEqual(tiers);
    expect(completed.map((entry) => entry.attempt)).toEqual(
      tiers.map((_, index) => index + 1),
    );
    expect(new Set(completed.map((entry) => entry.operationId)).size).toBe(1);
    expect(new Set(completed.map((entry) => entry.id)).size).toBe(tiers.length);
    expect(completed.at(-1)).toMatchObject({
      requestedServiceTier: failures < 3 ? "flex" : "default",
      actualServiceTier: failures < 3 ? "flex" : "default",
      cost: { amount: failures < 3 ? 0.004 : 0.008, pricingDate: "2026-09-19" },
    });
  },
);

it("stops after three Flex and three standard failures without hidden SDK retries", async () => {
  const tiers = mockArticleFetch(10);

  await expect(generateArticle()).rejects.toThrow();

  expect(tiers).toEqual([
    "flex",
    "flex",
    "flex",
    "default",
    "default",
    "default",
  ]);
  expect(records.filter((entry) => entry.status === "failed")).toHaveLength(6);
});

it("allows standard processing to be configured without Flex attempts", async () => {
  vi.stubEnv("ARTICLE_SERVICE_TIER", "default");
  const tiers = mockArticleFetch(10);

  await expect(generateArticle()).rejects.toThrow();

  expect(tiers).toEqual(["default", "default", "default"]);
});

it.each([400, 401, 403])(
  "does not retry or fall back on permanent HTTP %i errors",
  async (status) => {
    const tiers: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init: RequestInit) => {
        tiers.push(JSON.parse(String(init.body)).service_tier);
        return providerError(status, "false");
      }),
    );

    await expect(generateArticle()).rejects.toThrow();

    expect(tiers).toEqual(["flex"]);
  },
);

it("rejects an invalid tier before sending any request", async () => {
  vi.stubEnv("ARTICLE_SERVICE_TIER", "flxe");

  await expect(generateArticle()).rejects.toThrow(
    "Invalid ARTICLE_SERVICE_TIER",
  );

  expect(fetch).not.toHaveBeenCalled();
  expect(records).toHaveLength(0);
});

it("falls back after three HTTP timeouts", async () => {
  const tiers = mockArticleFetch(3, 408);

  await generateArticle();

  expect(tiers).toEqual(["flex", "flex", "flex", "default"]);
});

it("does not switch tiers after cancellation on the third Flex attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      attempts += 1;
      if (attempts === 3) {
        controller.abort();
      }
      return providerError();
    }),
  );

  await expect(generateArticle(controller.signal)).rejects.toThrow();

  expect(attempts).toBe(3);
  expect(records.at(-1)?.status).toBe("aborted");
});

it("checks the budget before the standard fallback is sent", async () => {
  const tiers = mockArticleFetch(3);
  const budgetRecorder = async (entry: ApiRequestUsage) => {
    if (
      entry.status === "pending" &&
      entry.requestedServiceTier === "default"
    ) {
      throw new Error("error.accountBudget");
    }
    await record(entry);
  };

  await expect(
    writeArticle(
      [{ id: "t-00001", start: 0, end: 1, text: "Hello", speaker: "Alice" }],
      {
        title: "Test",
        sourceName: "Test",
        language: "auto",
        length: "standard",
      },
      () => {},
      undefined,
      budgetRecorder,
    ),
  ).rejects.toThrow("error.accountBudget");

  expect(tiers).toEqual(["flex", "flex", "flex"]);
});
