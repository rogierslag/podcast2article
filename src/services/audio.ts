import { createWriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { safeFetch } from "../lib/network.js";

const DEFAULT_CHUNK_SECONDS = 300;

export function audioChunkSeconds(): number {
  const configured = Number(process.env.AUDIO_CHUNK_SECONDS ?? DEFAULT_CHUNK_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_CHUNK_SECONDS;
  return Math.min(1_200, Math.max(60, Math.floor(configured)));
}
const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static") as string | null;

export async function downloadAudio(url: string, target: string, signal?: AbortSignal): Promise<void> {
  const timeoutSignal = AbortSignal.timeout(120_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await safeFetch(url, { headers: { "User-Agent": "Podcast2Article/0.1 (+open-source)" }, signal: requestSignal });
  if (!response.ok || !response.body) throw new Error(`Audio downloaden mislukt (${response.status}).`);
  const maxBytes = Number(process.env.MAX_AUDIO_MB ?? 500) * 1024 * 1024;
  const announcedSize = Number(response.headers.get("content-length") ?? 0);
  if (announcedSize > maxBytes) throw new Error(`Audiobestand is groter dan ${process.env.MAX_AUDIO_MB ?? 500} MB.`);
  let received = 0;
  const limited = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maxBytes) return controller.error(new Error("Audiobestand overschrijdt de ingestelde limiet."));
      controller.enqueue(chunk);
    }
  }));
  await pipeline(Readable.fromWeb(limited as never), createWriteStream(target));
}

function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  if (!ffmpegPath) throw new Error("De meegeleverde FFmpeg-binary is niet beschikbaar voor dit platform.");
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const process = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const abort = () => process.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    process.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-8_000); });
    process.once("error", reject);
    process.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(signal.reason);
      return code === 0 ? resolve() : reject(new Error(`Audio verwerken mislukt: ${stderr.split("\n").at(-2) ?? `FFmpeg-code ${code}`}`));
    });
  });
}

export async function splitAudio(input: string, directory: string, signal?: AbortSignal): Promise<string[]> {
  const outputPattern = `${directory}/chunk-%03d.mp3`;
  const chunkSeconds = audioChunkSeconds();
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-i", input,
    "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k",
    "-f", "segment", "-segment_time", String(chunkSeconds), "-reset_timestamps", "1", outputPattern,
  ], signal);
  const files = (await readdir(directory))
    .filter((name) => /^chunk-\d+\.mp3$/.test(name))
    .sort()
    .map((name) => `${directory}/${name}`);
  if (!files.length) throw new Error("Er konden geen bruikbare audiofragmenten worden gemaakt.");
  for (const file of files) {
    if ((await stat(file)).size > 24 * 1024 * 1024) throw new Error("Een audiofragment is te groot voor transcriptie.");
  }
  return files;
}
