import { createReadStream } from "node:fs";
import OpenAI from "openai";
import { audioChunkSeconds } from "./audio.js";
import type { Article, TranscriptSegment } from "../types.js";

function client(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY ontbreekt. Geef de sleutel mee via de CLI-omgeving.");
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

interface DiarizedSegment { start?: number; end?: number; speaker?: string; text?: string; }

export async function transcribeChunks(
  files: string[],
  language: string,
  onProgress: (done: number, total: number) => void,
  onStatus: (message: string, data: Record<string, string | number>) => void = () => undefined,
  signal?: AbortSignal,
): Promise<TranscriptSegment[]> {
  const openai = client();
  const all: TranscriptSegment[] = [];
  const chunkSeconds = audioChunkSeconds();
  for (let index = 0; index < files.length; index += 1) {
    signal?.throwIfAborted();
    const chunkNumber = index + 1;
    const startedAt = Date.now();
    const timeoutMs = Number(process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS ?? 600_000);
    onStatus("OpenAI-transcriptieverzoek gestart", { chunk: `${chunkNumber}/${files.length}`, timeoutSeconds: Math.round(timeoutMs / 1000) });
    const heartbeat = setInterval(() => {
      onStatus("Nog in afwachting van OpenAI-transcriptie", {
        chunk: `${chunkNumber}/${files.length}`,
        waitingSeconds: Math.round((Date.now() - startedAt) / 1000),
      });
    }, 30_000);
    heartbeat.unref();
    let response: { segments?: DiarizedSegment[]; text?: string };
    try {
      response = await openai.audio.transcriptions.create({
        file: createReadStream(files[index]!),
        model: process.env.TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe-diarize",
        response_format: "diarized_json",
        chunking_strategy: "auto",
        language: language === "auto" ? undefined : language,
      } as never, { timeout: timeoutMs, signal }) as unknown as { segments?: DiarizedSegment[]; text?: string };
    } finally {
      clearInterval(heartbeat);
    }
    const offset = index * chunkSeconds;
    const segments = response.segments?.length
      ? response.segments
      : [{ start: 0, end: chunkSeconds, speaker: "Spreker", text: response.text ?? "" }];
    for (const segment of segments) {
      if (!segment.text?.trim()) continue;
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
  if (!all.length) throw new Error("OpenAI gaf geen transcripttekst terug.");
  return all;
}

const articleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "dek", "readingTimeMinutes", "styleNote", "sections", "takeaways"],
  properties: {
    title: { type: "string" },
    dek: { type: "string" },
    readingTimeMinutes: { type: "integer", minimum: 1 },
    styleNote: { type: "string" },
    sections: {
      type: "array", minItems: 2,
      items: {
        type: "object", additionalProperties: false, required: ["heading", "paragraphs"],
        properties: {
          heading: { type: "string" },
          paragraphs: { type: "array", minItems: 1, items: { $ref: "#/$defs/paragraph" } },
        },
      },
    },
    takeaways: { type: "array", minItems: 2, items: { $ref: "#/$defs/paragraph" } },
  },
  $defs: {
    paragraph: {
      type: "object", additionalProperties: false, required: ["text", "sources"],
      properties: {
        text: { type: "string" },
        sources: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
      },
    },
  },
} as const;

export function validateArticleSources(article: Article, validIds: Set<string>): Article {
  const paragraphs = [...article.sections.flatMap((section) => section.paragraphs), ...article.takeaways];
  for (const paragraph of paragraphs) {
    paragraph.sources = [...new Set(paragraph.sources)].filter((id) => validIds.has(id));
    if (!paragraph.sources.length) throw new Error("Het gegenereerde artikel bevat een alinea zonder geldige transcriptbron.");
  }
  return article;
}

export async function writeArticle(
  transcript: TranscriptSegment[],
  metadata: { title: string; podcast: string; language: string; length: string },
  onStatus: (message: string, data: Record<string, string | number>) => void = () => undefined,
  signal?: AbortSignal,
): Promise<Article> {
  signal?.throwIfAborted();
  const openai = client();
  const transcriptText = transcript
    .map((part) => `[${part.id}] ${part.speaker} ${part.start.toFixed(1)}-${part.end.toFixed(1)}: ${part.text}`)
    .join("\n");
  const targetWords = metadata.length === "compact" ? "700-1000" : metadata.length === "long" ? "1800-2600" : "1100-1700";
  const startedAt = Date.now();
  const timeoutMs = Number(process.env.OPENAI_ARTICLE_TIMEOUT_MS ?? 600_000);
  onStatus("OpenAI-artikelverzoek gestart", { transcriptSegments: transcript.length, timeoutSeconds: Math.round(timeoutMs / 1000) });
  const heartbeat = setInterval(() => {
    onStatus("Nog in afwachting van OpenAI-artikel", { waitingSeconds: Math.round((Date.now() - startedAt) / 1000) });
  }, 30_000);
  heartbeat.unref();
  let response;
  try {
    response = await openai.responses.create({
    model: process.env.ARTICLE_MODEL ?? "gpt-5.6-terra",
    instructions: `Je bent een zorgvuldige Nederlandse podcastredacteur. Schrijf uitsluitend op basis van het aangeleverde transcript.\n
Behoud de herkenbare stijl van de podcast: tempo, humor, directheid, terugkerende beeldspraak en de manier waarop argumenten en anekdotes worden opgebouwd. Maak er wel een helder zelfstandig blogartikel van. Je mag ordenen, inkorten, parafraseren en argumentatie vloeiender maken, maar nooit feiten, voorbeelden, motieven, conclusies, citaten of verbanden toevoegen. Zet parafrases niet tussen aanhalingstekens.\n
Elke alinea moet 1-5 source-ID's bevatten die de volledige inhoud van die alinea direct ondersteunen. Kies de nauwkeurigste fragmenten. Vermijd meta-commentaar zoals 'in de podcast'. Geef in styleNote in één korte zin aan welke stijleigenschappen je hebt behouden. Schrijf circa ${targetWords} woorden.`,
    input: `Podcast: ${metadata.podcast}\nAflevering: ${metadata.title}\nGewenste taal: ${metadata.language}\n\nTRANSCRIPT (enige inhoudelijke bron):\n${transcriptText}`,
    text: {
      format: {
        type: "json_schema",
        name: "source_linked_podcast_article",
        strict: true,
        schema: articleSchema,
      },
    },
    }, { timeout: timeoutMs, signal });
  } finally {
    clearInterval(heartbeat);
  }
  if (!response.output_text) throw new Error("OpenAI gaf geen artikel terug.");
  const article = JSON.parse(response.output_text) as Article;
  onStatus("OpenAI-artikel ontvangen", { elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), sections: article.sections.length });
  return validateArticleSources(article, new Set(transcript.map(({ id }) => id)));
}
