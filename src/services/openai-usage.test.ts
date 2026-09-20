import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { transcribeChunks, writeArticle } from "./openai.js";
import type { ApiRequestUsage, Article, TranscriptSegment } from "../types.js";

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

it.each([
  [
    "auto",
    "Detect the transcript's dominant language and write the entire article in that same language. Do not translate the source.",
  ],
  ["en", "Write the entire article in English."],
  ["nl", "Write the entire article in Dutch."],
])(
  "separates instructions from source content in one %s article request",
  async (language, languageInstruction) => {
    const transcript: TranscriptSegment[] = [
      {
        id: "t-00001",
        start: 0,
        end: 10,
        speaker: "Alice",
        text: "We reduced latency by caching reads.",
      },
      {
        id: "t-00002",
        start: 900,
        end: 910,
        speaker: "Alice",
        text: "Invalidation made the cache harder to maintain.",
      },
      {
        id: "t-00003",
        start: 1800,
        end: 1810,
        speaker: "Alice",
        text: "Owning maintenance changed how I chose projects.",
      },
    ];
    const generated: Article = {
      title: "The cost of caching",
      dek: "A faster read path also needs maintenance.",
      readingTimeMinutes: 1,
      styleNote: "Direct explanations and a personal lesson.",
      sections: [
        {
          heading: "Speed and maintenance",
          paragraphs: transcript.slice(0, 2).map(({ id, text }) => ({
            kind: "paragraph",
            text,
            sources: [id],
          })),
        },
        {
          heading: "Choosing projects",
          paragraphs: [
            {
              kind: "quote",
              text: "Owning maintenance changed how I chose projects.",
              sources: ["t-00003"],
            },
          ],
        },
      ],
      takeaways: [
        { text: "Account for cache maintenance.", sources: ["t-00002"] },
        { text: "Ownership affects project choices.", sources: ["t-00003"] },
      ],
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "resp-article",
            object: "response",
            status: "completed",
            model: "gpt-5.6-terra",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(generated),
                    annotations: [],
                  },
                ],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await writeArticle(transcript, {
      title: "Caching lessons",
      sourceName: "Engineering conversations",
      language,
      length: "standard",
    });

    expect(result).toEqual(generated);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") {
      throw new Error("Expected a JSON request body");
    }
    const payload: unknown = JSON.parse(body);
    expect(payload).toMatchObject({
      instructions: expect.stringContaining(languageInstruction),
    });
    expect(payload).toMatchObject({
      model: "gpt-5.6-terra",
      max_output_tokens: 16_384,
      instructions: expect.stringContaining(
        "Write approximately 1100-1700 words.",
      ),
      input: [
        {
          role: "user",
          content: `Source: Engineering conversations\nTitle: Caching lessons\n\nTRANSCRIPT (only factual source):\n[t-00001] Alice 0.0-10.0: We reduced latency by caching reads.\n[t-00002] Alice 900.0-910.0: Invalidation made the cache harder to maintain.\n[t-00003] Alice 1800.0-1810.0: Owning maintenance changed how I chose projects.`,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "source_linked_article",
          strict: true,
          schema: {
            $defs: {
              articleBlock: {
                properties: {
                  sources: {
                    items: { enum: ["t-00001", "t-00002", "t-00003"] },
                  },
                },
              },
              paragraph: {
                properties: {
                  sources: {
                    items: { enum: ["t-00001", "t-00002", "t-00003"] },
                  },
                },
              },
            },
          },
        },
      },
    });
  },
);

it("persists a chunk before deployment pauses new requests and resumes with its original offsets", async () => {
  const { chunkCheckpoint, atomicJson, readManifest } =
    await import("./processing-artifacts.js");
  const { paidRequestDrain } = await import("./deployment-drain.js");
  const manifest = {
    version: 1 as const,
    chunkSeconds: 300,
    model: "gpt-4o-transcribe-diarize",
    language: "en",
    files: ["chunk-000.mp3", "chunk-001.mp3"],
  };
  await atomicJson(path.join(directory, "chunks.json"), manifest);
  const checkpoint = chunkCheckpoint(directory, manifest);
  const controller = new AbortController();
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          text: "Hello",
          segments: [{ start: 1, end: 2, speaker: "Alice", text: "Hello" }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const interrupted = transcribeChunks(
    [audio, audio],
    "auto",
    () => {},
    () => {},
    controller.signal,
    record,
    {
      ...checkpoint,
      async save(index, response) {
        await checkpoint.save(index, response);
        paidRequestDrain.pause();
      },
    },
  );
  await vi.waitFor(async () => expect(await checkpoint.load(0)).toBeDefined());
  await vi.waitFor(() => expect(paidRequestDrain.pending).toBe(0));
  controller.abort();
  await expect(interrupted).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  paidRequestDrain.resume();
  vi.stubEnv("AUDIO_CHUNK_SECONDS", "600");
  vi.stubEnv("TRANSCRIPTION_MODEL", "a-different-model");
  const savedManifest = await readManifest(directory);
  expect(savedManifest).toBeDefined();

  const transcript = await transcribeChunks(
    [audio, audio],
    "nl",
    () => {},
    () => {},
    undefined,
    record,
    checkpoint,
  );

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(transcript.map(({ id, start }) => ({ id, start }))).toEqual([
    { id: "t-00001", start: 1 },
    { id: "t-00002", start: 301 },
  ]);
});

it("retrieves a saved background response after restart without another generation request", async () => {
  const { readFile } = await import("node:fs/promises");
  const { atomicJson } = await import("./processing-artifacts.js");
  const controller = new AbortController();
  const savedFile = path.join(directory, "article-response.json");
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      expect(body.background).toBe(true);
      expect(body.store).toBe(true);
      return new Response(
        JSON.stringify({ id: "resp-persisted", status: "queued", output: [] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return articleResponse("flex");
  });
  vi.stubGlobal("fetch", fetchMock);
  const transcript = [
    { id: "t-00001", start: 0, end: 1, text: "Hello", speaker: "Alice" },
  ];
  const metadata = {
    title: "Test",
    sourceName: "Test",
    language: "auto",
    length: "standard",
  };

  await expect(
    writeArticle(transcript, metadata, () => {}, controller.signal, record, {
      async save(state) {
        await atomicJson(savedFile, state);
        controller.abort();
      },
    }),
  ).rejects.toThrow();
  const state = JSON.parse(await readFile(savedFile, "utf8"));
  const result = await writeArticle(
    transcript,
    metadata,
    () => {},
    undefined,
    record,
    {
      state,
      save: (next) => atomicJson(savedFile, next),
    },
  );

  expect(result.title).toBe("Hello");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(records.at(-1)).toMatchObject({
    status: "succeeded",
    cost: { amount: 0.004 },
  });
  expect(new Set(records.map((entry) => entry.id)).size).toBe(1);
  const complete = JSON.parse(await readFile(savedFile, "utf8"));
  await writeArticle(transcript, metadata, () => {}, undefined, record, {
    state: complete,
    save: async () => {},
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("retains an invalid article answer before local validation fails", async () => {
  let saved: import("../types.js").BackgroundArticle | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "resp-invalid",
            object: "response",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "invalid JSON",
                    annotations: [],
                  },
                ],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ),
  );
  const transcript = [
    { id: "t-00001", start: 0, end: 1, text: "Hello", speaker: "Alice" },
  ];
  const metadata = {
    title: "Test",
    sourceName: "Test",
    language: "auto",
    length: "standard",
  };

  await expect(
    writeArticle(transcript, metadata, () => {}, undefined, record, {
      save: async (state) => {
        saved = state;
      },
    }),
  ).rejects.toThrow();
  expect(saved?.answer).toBe("invalid JSON");
  await expect(
    writeArticle(transcript, metadata, () => {}, undefined, record, {
      state: saved,
      save: async () => {},
    }),
  ).rejects.toThrow();

  expect(fetch).toHaveBeenCalledTimes(1);
});
