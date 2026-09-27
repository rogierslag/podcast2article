import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApiRequestUsage,
  Article,
  BackgroundArticle,
  TranscriptSegment,
} from "../types.js";
import type { ArticleCheckpoint } from "./background-article.js";
import { repairArticleQuotes } from "./quote-repair.js";
import { writeArticle } from "./openai.js";
import { paidRequestDrain } from "./deployment-drain.js";

const transcript: TranscriptSegment[] = [
  {
    id: "t-00001",
    start: 0,
    end: 4,
    speaker: "Speaker",
    text: "We always verify our sources before publishing.",
  },
];
const draft: Article = {
  title: "Sources",
  dek: "A careful approach",
  readingTimeMinutes: 1,
  styleNote: "Direct",
  sections: [
    {
      heading: "Verification",
      paragraphs: [
        {
          kind: "paragraph",
          text: "Verification matters.",
          sources: ["t-00001"],
        },
        {
          kind: "quote",
          text: "We fact-check absolutely everything.",
          sources: ["t-00001"],
        },
        {
          kind: "quote",
          text: "We always verify our sources",
          sources: ["t-00001"],
        },
      ],
    },
  ],
  takeaways: [{ text: "Check sources.", sources: ["t-00001"] }],
};
const corrected = "We always verify our sources before publishing.";
const repair = (text: string | null) => ({
  repairs: [{ sectionIndex: 0, paragraphIndex: 1, text }],
});
let records: ApiRequestUsage[];
let saved: BackgroundArticle[];
let checkpoint: ArticleCheckpoint;

function providerResponse(
  answer: unknown,
  status = "completed",
  id = "resp-repair",
) {
  return new Response(
    JSON.stringify({
      id,
      object: "response",
      status,
      model: "gpt-5.6-terra",
      service_tier: "default",
      output:
        status === "completed"
          ? [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(answer),
                    annotations: [],
                  },
                ],
              },
            ]
          : [],
      usage:
        status === "completed"
          ? { input_tokens: 100, output_tokens: 50 }
          : undefined,
    }),
    {
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-test-repair",
      },
    },
  );
}

function run(article = structuredClone(draft), signal?: AbortSignal) {
  return repairArticleQuotes(article, transcript, {
    openai: new OpenAI({ apiKey: "test-only" }),
    model: "gpt-5.6-terra",
    serviceTier: "default",
    timeoutMs: 1000,
    signal,
    checkpoint,
    recordUsage: async (request) => {
      records.push(structuredClone(request));
    },
  });
}

beforeEach(() => {
  records = [];
  saved = [];
  checkpoint = {
    repairs: saved,
    save: async () => {},
    saveRepair: async (index, response) => {
      saved[index] = structuredClone(response);
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network request");
    }),
  );
});
afterEach(() => {
  paidRequestDrain.resume();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("quote-only repair", () => {
  it("repairs only invalid blocks and accounts for the paid request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => providerResponse(repair(corrected))),
    );

    const result = await run();

    const expected = structuredClone(draft);
    const block = expected.sections[0]?.paragraphs[1];
    if (!block) {
      throw new Error("Missing fixture block");
    }
    block.text = corrected;
    expect(result).toEqual(expected);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe("string");
    const payload = JSON.parse(String(body));
    expect(JSON.parse(payload.input)).toEqual([
      {
        sectionIndex: 0,
        paragraphIndex: 1,
        text: draft.sections[0]?.paragraphs[1]?.text,
        sources: [{ id: "t-00001", text: corrected }],
      },
    ]);
    expect(payload.background).toBe(true);
    expect(records.map((request) => request.status)).toEqual([
      "pending",
      "succeeded",
    ]);
    expect(records[0]?.reservedCostUsd).toBeGreaterThan(0);
    expect(saved[0]?.answer).toBe(JSON.stringify(repair(corrected)));
  });

  it("makes no request for valid quotes or ordinary prose", async () => {
    const article = structuredClone(draft);
    article.sections[0]?.paragraphs.splice(1, 1);

    expect(await run(article)).toEqual(article);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries only remaining invalid quotes and stops after two repair rounds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        providerResponse(repair("Invented words are not a quote.")),
      ),
    );

    const result = await run();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.sections[0]?.paragraphs).toEqual([
      draft.sections[0]?.paragraphs[0],
      draft.sections[0]?.paragraphs[2],
    ]);
    expect(result.takeaways).toEqual(draft.takeaways);
  });

  it("replays an exhausted repair budget after restart without extra requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => providerResponse(repair("Still not a literal quote."))),
    );
    const first = await run();
    vi.mocked(fetch).mockClear();

    const resumed = await run();

    expect(resumed).toEqual(first);
    expect(saved).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps block indices stable when an earlier quote is omitted", async () => {
    const article = structuredClone(draft);
    article.sections[0]?.paragraphs.push({
      kind: "quote",
      text: "A second unsupported quote.",
      sources: ["t-00001"],
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          providerResponse({
            repairs: [
              ...repair(null).repairs,
              {
                sectionIndex: 0,
                paragraphIndex: 3,
                text: "Still unsupported text here.",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          providerResponse({
            repairs: [{ sectionIndex: 0, paragraphIndex: 3, text: corrected }],
          }),
        ),
    );
    const original = structuredClone(article);

    const first = await run(article);
    vi.mocked(fetch).mockClear();
    const resumed = await run(original);

    expect(resumed).toEqual(first);
    expect(first.sections[0]?.paragraphs.at(-1)?.text).toBe(corrected);
    expect(first.sections[0]?.paragraphs).toHaveLength(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("removes empty sections but refuses to publish an empty article", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => providerResponse(repair(null))),
    );
    const article = structuredClone(draft);
    const invalid = article.sections[0]?.paragraphs[1];
    if (!invalid) {
      throw new Error("Missing fixture quote");
    }
    article.sections = [{ heading: "Only quotes", paragraphs: [invalid] }];

    await expect(run(article)).rejects.toThrow("no supported article sections");
  });

  it("accepts a valid second correction without regenerating the article", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          providerResponse(repair("Wrong words still are not sourced.")),
        )
        .mockResolvedValueOnce(providerResponse(repair(corrected))),
    );

    const result = await run();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.sections[0]?.paragraphs[1]?.text).toBe(corrected);
  });

  it("omits an explicitly unrepairable optional quote", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => providerResponse(repair(null))),
    );

    const result = await run();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.sections[0]?.paragraphs).toHaveLength(2);
  });

  it("ignores attempts to rewrite valid blocks or change their source references", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        providerResponse({
          repairs: [
            {
              sectionIndex: 0,
              paragraphIndex: 0,
              text: "Malicious replacement",
            },
            { sectionIndex: 0, paragraphIndex: 2, text: "Another replacement" },
            ...repair(corrected).repairs,
          ],
        }),
      ),
    );

    const result = await run();

    expect(result.sections[0]?.paragraphs[0]).toEqual(
      draft.sections[0]?.paragraphs[0],
    );
    expect(result.sections[0]?.paragraphs[2]).toEqual(
      draft.sections[0]?.paragraphs[2],
    );
  });

  it("replays completed repair checkpoints without paying again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => providerResponse(repair(corrected))),
    );
    const first = await run();
    vi.mocked(fetch).mockClear();

    const resumed = await run();

    expect(resumed).toEqual(first);
    expect(fetch).not.toHaveBeenCalled();
    expect(records.at(-1)?.id).toBe(saved[0]?.request.id);
  });

  it("resumes a queued repair by retrieval after interruption", async () => {
    const controller = new AbortController();
    checkpoint.saveRepair = async (index, response) => {
      saved[index] = structuredClone(response);
      controller.abort();
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => providerResponse(undefined, "queued")),
    );
    await expect(run(undefined, controller.signal)).rejects.toThrow();
    checkpoint.saveRepair = async (index, response) => {
      saved[index] = structuredClone(response);
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => providerResponse(repair(corrected))),
    );

    const result = await run();

    expect(result.sections[0]?.paragraphs[1]?.text).toBe(corrected);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      "/responses/resp-repair",
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("honors deployment admission and cancellation before submitting repair", async () => {
    paidRequestDrain.pause();
    const controller = new AbortController();
    const promise = run(undefined, controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps permanent API failures visible without discarding the original draft", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: "No credit", type: "insufficient_quota" },
            }),
            { status: 400 },
          ),
      ),
    );
    const article = structuredClone(draft);

    await expect(run(article)).rejects.toThrow();

    expect(article).toEqual(draft);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not submit when budget accounting rejects the reservation", async () => {
    await expect(
      repairArticleQuotes(structuredClone(draft), transcript, {
        openai: new OpenAI({ apiKey: "test-only" }),
        model: "gpt-5.6-terra",
        serviceTier: "default",
        timeoutMs: 1000,
        recordUsage: async () => {
          throw new Error("Budget exceeded");
        },
      }),
    ).rejects.toThrow("Budget exceeded");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("repairs a saved original article through the writing pipeline", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          providerResponse(draft, "completed", "resp-original"),
        )
        .mockResolvedValueOnce(providerResponse(repair(corrected))),
    );
    checkpoint.save = async (state) => {
      checkpoint.state = structuredClone(state);
    };

    const result = await writeArticle(
      transcript,
      { title: "Test", sourceName: "Test", language: "en", length: "standard" },
      () => {},
      undefined,
      async (request) => {
        records.push(request);
      },
      checkpoint,
    );

    expect(result.sections[0]?.paragraphs[1]?.text).toBe(corrected);
    expect(checkpoint.state?.answer).toBe(JSON.stringify(draft));
    expect(saved[0]?.answer).toBe(JSON.stringify(repair(corrected)));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
