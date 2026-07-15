import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { transcribeChunks, validateArticleSources } from "./openai.js";
import type { Article } from "../types.js";

const article: Article = {
  title: "Titel", dek: "Intro", readingTimeMinutes: 3, styleNote: "Direct.",
  sections: [{ heading: "Een", paragraphs: [{ text: "Tekst", sources: ["t-00001", "onbekend"] }] }],
  takeaways: [{ text: "Punt", sources: ["t-00002"] }],
};

describe("article source validation", () => {
  it("removes hallucinated source ids", () => {
    expect(validateArticleSources(structuredClone(article), new Set(["t-00001", "t-00002"])).sections[0]?.paragraphs[0]?.sources).toEqual(["t-00001"]);
  });

  it("rejects unsupported paragraphs", () => {
    const invalid = structuredClone(article);
    invalid.takeaways[0]!.sources = ["missing"];
    expect(() => validateArticleSources(invalid, new Set(["t-00001"]))).toThrow(/zonder geldige transcriptbron/);
  });
});

describe("OpenAI request cancellation", () => {
  it("aborts an in-flight transcription through its AbortSignal", async () => {
    const controller = new AbortController();
    const server = createServer((request, response) => {
      request.once("close", () => response.destroy());
      setTimeout(() => controller.abort(new DOMException("test shutdown", "AbortError")), 25);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const directory = await mkdtemp(path.join(tmpdir(), "podcast2article-abort-"));
    const audio = path.join(directory, "chunk.mp3");
    await writeFile(audio, Buffer.from("fake audio"));
    const previousKey = process.env.OPENAI_API_KEY;
    const previousBaseUrl = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = "sk-test-only";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;

    try {
      await expect(transcribeChunks([audio], "auto", () => undefined, () => undefined, controller.signal)).rejects.toBeDefined();
      expect(controller.signal.aborted).toBe(true);
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
      if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previousBaseUrl;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
