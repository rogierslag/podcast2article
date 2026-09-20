import { createReadStream } from "node:fs";
import OpenAI from "openai";
import type { ProcessingEvent } from "../lib/processing-events.js";
import { DomainError } from "../lib/errors.js";
import { endpointRegion, trackedRequest, reserveApiCost } from "./api-usage.js";
import type { UsageRecorder } from "./api-usage.js";
import { formatArticleWordRange } from "../../public/article-length.js";
import { audioChunkSeconds } from "./audio.js";
import type { Article, TranscriptSegment } from "../types.js";

const OPENAI_REGION_BASE_URLS = {
  eu: "https://eu.api.openai.com/v1",
  us: "https://us.api.openai.com/v1",
} as const;

export function openAIBaseURL(
  region = process.env.OPENAI_REGION,
): string | undefined {
  const normalizedRegion = region?.trim().toLowerCase() || "global";
  if (normalizedRegion === "global") {
    return undefined;
  }
  if (normalizedRegion === "eu" || normalizedRegion === "us") {
    return OPENAI_REGION_BASE_URLS[normalizedRegion];
  }
  throw new Error(
    `Ongeldige OPENAI_REGION "${region}". Gebruik "global", "eu" of "us".`,
  );
}

function client(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY ontbreekt. Geef de sleutel mee via de CLI-omgeving.",
    );
  }
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || openAIBaseURL(),
  });
}

export function articleServiceTier(): "flex" | "default" {
  const tier = process.env.ARTICLE_SERVICE_TIER?.trim().toLowerCase() || "flex";
  if (tier === "flex" || tier === "default") {
    return tier;
  }
  throw new Error('Invalid ARTICLE_SERVICE_TIER. Use "flex" or "default".');
}

interface DiarizedSegment {
  start?: number;
  end?: number;
  speaker?: string;
  text?: string;
}

export async function transcribeChunks(
  files: string[],
  language: string,
  onProgress: (done: number, total: number) => void,
  onStatus: (event: ProcessingEvent) => void = () => undefined,
  signal?: AbortSignal,
  recordUsage?: UsageRecorder,
): Promise<TranscriptSegment[]> {
  const openai = client();
  const all: TranscriptSegment[] = [];
  const chunkSeconds = audioChunkSeconds();
  for (let index = 0; index < files.length; index += 1) {
    signal?.throwIfAborted();
    const chunkNumber = index + 1;
    const startedAt = Date.now();
    const timeoutMs = Number(
      process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS ?? 600_000,
    );
    onStatus({
      type: "transcription.started",
      message: "OpenAI-transcriptieverzoek gestart",
      data: {
        chunk: `${chunkNumber}/${files.length}`,
        timeoutSeconds: Math.round(timeoutMs / 1000),
      },
    });
    const heartbeat = setInterval(() => {
      onStatus({
        type: "transcription.waiting",
        message: "Nog in afwachting van OpenAI-transcriptie",
        data: {
          chunk: `${chunkNumber}/${files.length}`,
          waitingSeconds: Math.round((Date.now() - startedAt) / 1000),
        },
      });
    }, 30_000);
    heartbeat.unref();
    let response: { segments?: DiarizedSegment[]; text?: string };
    try {
      const model =
        process.env.TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe-diarize";
      response = await trackedRequest(
        {
          stage: "transcription",
          model,
          region: endpointRegion(openai.baseURL),
          reservedCostUsd: reserveApiCost(
            model,
            endpointRegion(openai.baseURL),
            { audioSeconds: chunkSeconds + 1 },
          ),
          chunkNumber,
          signal,
          record: recordUsage,
        },
        () =>
          openai.audio.transcriptions
            .create(
              {
                file: createReadStream(files[index]!),
                model,
                response_format: "diarized_json",
                chunking_strategy: "auto",
                language: language === "auto" ? undefined : language,
              } as never,
              { timeout: timeoutMs, signal, maxRetries: 0 },
            )
            .withResponse(),
      );
    } finally {
      clearInterval(heartbeat);
    }
    const offset = index * chunkSeconds;
    const segments = response.segments?.length
      ? response.segments
      : [
          {
            start: 0,
            end: chunkSeconds,
            speaker: "Spreker",
            text: response.text ?? "",
          },
        ];
    for (const segment of segments) {
      if (!segment.text?.trim()) {
        continue;
      }
      const number = all.length + 1;
      all.push({
        id: `t-${String(number).padStart(5, "0")}`,
        start: offset + (segment.start ?? 0),
        end: offset + (segment.end ?? segment.start ?? 0),
        speaker: segment.speaker?.trim() || "Spreker",
        text: segment.text.trim(),
      });
    }
    onStatus({
      type: "transcription.completed",
      message: "OpenAI-transcriptiefragment ontvangen",
      data: {
        chunk: `${chunkNumber}/${files.length}`,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        segments: segments.length,
      },
    });
    onProgress(index + 1, files.length);
  }
  if (!all.length) {
    throw new DomainError("error.transcriptMissing");
  }
  return all;
}

const articleSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "dek",
    "readingTimeMinutes",
    "styleNote",
    "sections",
    "takeaways",
  ],
  properties: {
    title: { type: "string" },
    dek: { type: "string" },
    readingTimeMinutes: { type: "integer", minimum: 1 },
    styleNote: { type: "string" },
    sections: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "paragraphs"],
        properties: {
          heading: { type: "string" },
          paragraphs: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/$defs/articleBlock" },
          },
        },
      },
    },
    takeaways: {
      type: "array",
      minItems: 2,
      items: { $ref: "#/$defs/paragraph" },
    },
  },
  $defs: {
    articleBlock: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "text", "sources"],
      properties: {
        kind: { type: "string", enum: ["paragraph", "quote"] },
        text: { type: "string" },
        sources: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string" },
        },
      },
    },
    paragraph: {
      type: "object",
      additionalProperties: false,
      required: ["text", "sources"],
      properties: {
        text: { type: "string" },
        sources: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string" },
        },
      },
    },
  },
} as const;

function articleSchemaFor(validIds: string[]): Record<string, unknown> {
  const schema = structuredClone(articleSchema) as unknown as {
    $defs: {
      articleBlock: {
        properties: { sources: { items: Record<string, unknown> } };
      };
      paragraph: {
        properties: { sources: { items: Record<string, unknown> } };
      };
    };
  };
  schema.$defs.paragraph.properties.sources.items = {
    type: "string",
    enum: validIds,
  };
  schema.$defs.articleBlock.properties.sources.items = {
    type: "string",
    enum: validIds,
  };
  return schema as unknown as Record<string, unknown>;
}

function normalizeSourceId(value: string): string | undefined {
  const match = value.trim().match(/^\[?t?[-_ ]?0*(\d{1,5})\]?$/i);
  if (!match?.[1]) {
    return undefined;
  }
  return `t-${String(Number(match[1])).padStart(5, "0")}`;
}

export function validateArticleSources(
  article: Article,
  validIds: Set<string>,
): Article {
  const paragraphs = [
    ...article.sections.flatMap((section) => section.paragraphs),
    ...article.takeaways,
  ];
  for (const paragraph of paragraphs) {
    const received = paragraph.sources;
    paragraph.sources = [
      ...new Set(
        received
          .map((id) => (validIds.has(id) ? id : normalizeSourceId(id)))
          .filter((id): id is string => Boolean(id && validIds.has(id))),
      ),
    ];
    if (!paragraph.sources.length) {
      const sample =
        received.slice(0, 5).join(", ") || "geen bron-ID ontvangen";
      throw new Error(
        `Het gegenereerde artikel bevat een alinea zonder geldige transcriptbron (ontvangen: ${sample}).`,
      );
    }
  }
  return article;
}

function words(value: string): string[] {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []
  );
}

export function validateArticleQuotes(
  article: Article,
  transcript: TranscriptSegment[],
): Article {
  const transcriptById = new Map(
    transcript.map((segment) => [segment.id, segment.text]),
  );

  for (const block of article.sections.flatMap(
    (section) => section.paragraphs,
  )) {
    if (block.kind !== "quote") {
      continue;
    }

    const quoteWords = words(block.text);
    const sourceWords = words(
      block.sources
        .map((sourceId) => transcriptById.get(sourceId) ?? "")
        .join(" "),
    );
    const sourceText = ` ${sourceWords.join(" ")} `;
    const quoteText = ` ${quoteWords.join(" ")} `;
    if (quoteWords.length < 4 || !sourceText.includes(quoteText)) {
      throw new Error(
        "Het gegenereerde artikel bevat een citaat dat niet letterlijk in de gekoppelde transcriptbron staat.",
      );
    }
  }

  return article;
}

const ARTICLE_LANGUAGE_NAMES: Record<string, string> = {
  nl: "Dutch",
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
};

export function articleLanguageInstruction(language: string): string {
  if (language === "auto") {
    return "Detect the transcript's dominant language and write the entire article in that same language. Do not translate the source.";
  }
  return `Write the entire article in ${ARTICLE_LANGUAGE_NAMES[language] ?? language}.`;
}

export async function writeArticle(
  transcript: TranscriptSegment[],
  metadata: {
    title: string;
    sourceName: string;
    language: string;
    length: string;
  },
  onStatus: (event: ProcessingEvent) => void = () => undefined,
  signal?: AbortSignal,
  recordUsage?: UsageRecorder,
): Promise<Article> {
  signal?.throwIfAborted();
  const openai = client();
  const validIds = transcript.map(({ id }) => id);
  const serviceTier = articleServiceTier();
  const transcriptText = transcript
    .map(
      (part) =>
        `[${part.id}] ${part.speaker} ${part.start.toFixed(1)}-${part.end.toFixed(1)}: ${part.text}`,
    )
    .join("\n");
  const targetWords = formatArticleWordRange(metadata.length);
  const startedAt = Date.now();
  const timeoutMs = Number(process.env.OPENAI_ARTICLE_TIMEOUT_MS ?? 600_000);
  onStatus({
    type: "article.started",
    message: "OpenAI-artikelverzoek gestart",
    data: {
      transcriptSegments: transcript.length,
      timeoutSeconds: Math.round(timeoutMs / 1000),
    },
  });
  const heartbeat = setInterval(() => {
    onStatus({
      type: "article.waiting",
      message: "Nog in afwachting van OpenAI-artikel",
      data: {
        waitingSeconds: Math.round((Date.now() - startedAt) / 1000),
      },
    });
  }, 30_000);
  heartbeat.unref();
  let response;
  try {
    const model = process.env.ARTICLE_MODEL ?? "gpt-5.6-terra";
    // Preserve the coverage wording evaluated in docs/ARTICLE-COVERAGE-EVALUATION.md.
    const payload: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model,
      service_tier: serviceTier,
      max_output_tokens: 16_384,
      instructions: `You are a careful editor. Write solely from the supplied transcript.

${articleLanguageInstruction(metadata.language)}

Preserve the recording's recognizable style: pace, humor, directness, recurring imagery, and the way arguments and anecdotes are developed. Turn it into a clear, standalone blog article. You may reorganize, shorten, paraphrase, and improve the flow of arguments, but never add facts, examples, motives, conclusions, quotes, or connections. Do not put paraphrases in quotation marks.

Use a few quote blocks throughout the sections for verbatim, self-contained, memorable statements, but only if the transcript contains such statements. Set kind to "quote" and copy the spoken words exactly from the linked, consecutive source segments; omit surrounding quotation marks. Otherwise use kind "paragraph". Do not force quotes or use quote blocks for paraphrases.

Each paragraph must contain 1-5 source IDs that directly support its entire content. Choose the most precise segments. Avoid meta-commentary such as 'in the podcast' or 'in the recording'. In styleNote, describe the stylistic features you preserved in one short sentence. Write approximately ${targetWords} words.

COVERAGE REQUIREMENT: Before writing, survey the complete transcript and choose the main substantive topics across the beginning, middle and end. Preserve each central assertion, its defining example or qualification, important counterarguments, and substantive career or personal stories when these explain the episode. Do not let an attractive opening theme turn the article into a narrower essay that silently loses other major topics. Exclude ads, housekeeping and repetition. Allocate space across the topics before drafting; when space is tight, combine related themes and shorten explanations before dropping a distinct main topic. Internally check the finished article for accidental omissions and unsupported additions. Return only the final article JSON, not a plan or review. The transcript remains the only factual source; publisher writing and external knowledge must not be used.
`,
      input: [
        {
          role: "user",
          content: `Source: ${metadata.sourceName}\nTitle: ${metadata.title}\n\nTRANSCRIPT (only factual source):\n${transcriptText}`,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "source_linked_article",
          strict: true,
          schema: articleSchemaFor(validIds),
        },
      },
    };
    const reservedCostUsd = reserveApiCost(
      model,
      endpointRegion(openai.baseURL),
      {
        inputBytes: Buffer.byteLength(JSON.stringify(payload)),
        outputTokens: 16_384,
      },
    );
    response = await trackedRequest(
      {
        stage: "article",
        serviceTier,
        reservedCostUsd,
        model,
        region: endpointRegion(openai.baseURL),
        signal,
        record: recordUsage,
      },
      (requestedTier) =>
        openai.responses
          .create(
            { ...payload, service_tier: requestedTier },
            { timeout: timeoutMs, signal, maxRetries: 0 },
          )
          .withResponse(),
    );
  } finally {
    clearInterval(heartbeat);
  }
  if (!response.output_text) {
    throw new DomainError("error.articleMissing");
  }
  const article = JSON.parse(response.output_text) as Article;
  onStatus({
    type: "article.completed",
    message: "OpenAI-artikel ontvangen",
    data: {
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      sections: article.sections.length,
    },
  });
  validateArticleSources(article, new Set(validIds));
  return validateArticleQuotes(article, transcript);
}
