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
  expect(records[1]).toMatchObject({
    stage: "article",
    status: "succeeded",
    actualModel: "gpt-5.6-terra",
    actualServiceTier: "default",
    requestId: "req-article",
    cost: { amount: 0.00764 },
  });
});
