import { createReadStream } from "node:fs";
import OpenAI from "openai";
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
  onStatus: (
    message: string,
    data: Record<string, string | number>,
  ) => void = () => undefined,
  signal?: AbortSignal,
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
    onStatus("OpenAI-transcriptieverzoek gestart", {
      chunk: `${chunkNumber}/${files.length}`,
      timeoutSeconds: Math.round(timeoutMs / 1000),
    });
    const heartbeat = setInterval(() => {
      onStatus("Nog in afwachting van OpenAI-transcriptie", {
        chunk: `${chunkNumber}/${files.length}`,
        waitingSeconds: Math.round((Date.now() - startedAt) / 1000),
      });
    }, 30_000);
    heartbeat.unref();
    let response: { segments?: DiarizedSegment[]; text?: string };
    try {
      response = (await openai.audio.transcriptions.create(
        {
          file: createReadStream(files[index]!),
          model: process.env.TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe-diarize",
          response_format: "diarized_json",
          chunking_strategy: "auto",
          language: language === "auto" ? undefined : language,
        } as never,
        { timeout: timeoutMs, signal },
      )) as unknown as { segments?: DiarizedSegment[]; text?: string };
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
    onStatus("OpenAI-transcriptiefragment ontvangen", {
      chunk: `${chunkNumber}/${files.length}`,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      segments: segments.length,
    });
    onProgress(index + 1, files.length);
  }
  if (!all.length) {
    throw new Error("OpenAI gaf geen transcripttekst terug.");
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
            items: { $ref: "#/$defs/paragraph" },
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
      paragraph: {
        properties: { sources: { items: Record<string, unknown> } };
      };
    };
  };
  schema.$defs.paragraph.properties.sources.items = {
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

const ARTICLE_LANGUAGE_NAMES: Record<string, string> = {
  nl: "Nederlands",
  en: "Engels",
  de: "Duits",
  fr: "Frans",
  es: "Spaans",
};

export function articleLanguageInstruction(language: string): string {
  if (language === "auto") {
    return "Detecteer de dominante taal van het transcript en schrijf het volledige artikel in diezelfde taal. Vertaal de bron niet.";
  }
  return `Schrijf het volledige artikel in het ${ARTICLE_LANGUAGE_NAMES[language] ?? language}.`;
}

export async function writeArticle(
  transcript: TranscriptSegment[],
  metadata: {
    title: string;
    sourceName: string;
    language: string;
    length: string;
  },
  onStatus: (
    message: string,
    data: Record<string, string | number>,
  ) => void = () => undefined,
  signal?: AbortSignal,
): Promise<Article> {
  signal?.throwIfAborted();
  const openai = client();
  const validIds = transcript.map(({ id }) => id);
  const transcriptText = transcript
    .map(
      (part) =>
        `[${part.id}] ${part.speaker} ${part.start.toFixed(1)}-${part.end.toFixed(1)}: ${part.text}`,
    )
    .join("\n");
  const targetWords =
    metadata.length === "compact"
      ? "700-1000"
      : metadata.length === "long"
        ? "1800-2600"
        : "1100-1700";
  const startedAt = Date.now();
  const timeoutMs = Number(process.env.OPENAI_ARTICLE_TIMEOUT_MS ?? 600_000);
  onStatus("OpenAI-artikelverzoek gestart", {
    transcriptSegments: transcript.length,
    timeoutSeconds: Math.round(timeoutMs / 1000),
  });
  const heartbeat = setInterval(() => {
    onStatus("Nog in afwachting van OpenAI-artikel", {
      waitingSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  }, 30_000);
  heartbeat.unref();
  let response;
  try {
    response = await openai.responses.create(
      {
        model: process.env.ARTICLE_MODEL ?? "gpt-5.6-terra",
        instructions: `Je bent een zorgvuldige redacteur. Schrijf uitsluitend op basis van het aangeleverde transcript.\n
Behoud de herkenbare stijl van de opname: tempo, humor, directheid, terugkerende beeldspraak en de manier waarop argumenten en anekdotes worden opgebouwd. Maak er wel een helder zelfstandig blogartikel van. Je mag ordenen, inkorten, parafraseren en argumentatie vloeiender maken, maar nooit feiten, voorbeelden, motieven, conclusies, citaten of verbanden toevoegen. Zet parafrases niet tussen aanhalingstekens.\n
Elke alinea moet 1-5 source-ID's bevatten die de volledige inhoud van die alinea direct ondersteunen. Kies de nauwkeurigste fragmenten. Vermijd meta-commentaar zoals 'in de podcast' of 'in de opname'. Geef in styleNote in één korte zin aan welke stijleigenschappen je hebt behouden. Schrijf circa ${targetWords} woorden.`,
        input: `Bron: ${metadata.sourceName}\nTitel: ${metadata.title}\nTaalinstructie: ${articleLanguageInstruction(metadata.language)}\n\nTRANSCRIPT (enige inhoudelijke bron):\n${transcriptText}`,
        text: {
          format: {
            type: "json_schema",
            name: "source_linked_article",
            strict: true,
            schema: articleSchemaFor(validIds),
          },
        },
      },
      { timeout: timeoutMs, signal },
    );
  } finally {
    clearInterval(heartbeat);
  }
  if (!response.output_text) {
    throw new Error("OpenAI gaf geen artikel terug.");
  }
  const article = JSON.parse(response.output_text) as Article;
  onStatus("OpenAI-artikel ontvangen", {
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    sections: article.sections.length,
  });
  return validateArticleSources(article, new Set(validIds));
}
