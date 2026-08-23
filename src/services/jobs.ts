import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { jobError, jobLog } from "../lib/logger.js";
import { audioChunkSeconds, downloadMedia, normalizeAudio, splitAudio } from "./audio.js";
import { transcribeChunks, writeArticle } from "./openai.js";
import { resolveSource } from "./resolver.js";
import { downloadYouTubeAudio } from "./youtube.js";
import type { ArticleSummary, Job, ProcessingJobSummary } from "../types.js";

const root = path.resolve("data");
const jobDirectory = path.join(root, "jobs");
const workDirectory = path.join(root, "work");
const mediaDirectory = path.join(root, "media");
const memory = new Map<string, Job>();
const activeRuns = new Map<string, { controller: AbortController; promise: Promise<void> }>();
const pendingRuns: Array<{ job: Job; type: "full" | "article" }> = [];
const pendingJobIds = new Set<string>();
let shuttingDown = false;

function mediaLimit(sourceType: NonNullable<Job["episode"]>["sourceType"]): number {
  const fallback = sourceType === "google-drive" ? 1_500 : 500;
  const value = Number(
    sourceType === "google-drive"
      ? process.env.MAX_RECORDING_MB ?? process.env.MAX_MEDIA_MB ?? fallback
      : sourceType === "youtube"
        ? process.env.MAX_YOUTUBE_MB ?? process.env.MAX_AUDIO_MB ?? process.env.MAX_MEDIA_MB ?? fallback
      : process.env.MAX_AUDIO_MB ?? process.env.MAX_MEDIA_MB ?? fallback,
  );
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function normalizeStoredJob(job: Job): Job {
  job.sourceUrl ??= job.spotifyUrl ?? "";
  if (job.stage === "complete") job.completedAt ??= job.updatedAt;
  if (job.episode) {
    job.episode.sourceUrl ??= job.episode.spotifyUrl ?? job.sourceUrl;
    job.episode.sourceType ??= "spotify";
    job.episode.sourceName ??= job.episode.podcast ?? "Onbekende podcast";
    job.episode.mediaUrl ??= job.episode.audioUrl ?? "";
    job.episode.playbackUrl ??= job.episode.audioUrl;
  }
  return job;
}

export function playbackFileForJob(id: string): string | undefined {
  return /^[0-9a-f-]{36}$/i.test(id) ? path.join(mediaDirectory, `${id}.mp3`) : undefined;
}

async function persist(job: Job): Promise<void> {
  await mkdir(jobDirectory, { recursive: true });
  job.updatedAt = new Date().toISOString();
  memory.set(job.id, job);
  await writeFile(path.join(jobDirectory, `${job.id}.json`), JSON.stringify(job, null, 2));
}

async function update(job: Job, patch: Partial<Job>): Promise<void> {
  Object.assign(job, patch);
  await persist(job);
}

export async function createJob(input: Pick<Job, "sourceUrl" | "language" | "articleLength">): Promise<Job> {
  const now = new Date().toISOString();
  const sourceHost = new URL(input.sourceUrl).hostname.toLowerCase();
  const job: Job = {
    ...input,
    ...(sourceHost === "open.spotify.com" || sourceHost === "spotify.com" || sourceHost === "www.spotify.com"
      ? { spotifyUrl: input.sourceUrl }
      : {}),
    id: randomUUID(),
    stage: "queued",
    progress: 2,
    message: "Opdracht staat klaar",
    createdAt: now,
    updatedAt: now,
  };
  await persist(job);
  jobLog(job.id, job.stage, "Opdracht aangemaakt", { language: job.language, articleLength: job.articleLength });
  enqueueJob(job, "full");
  return job;
}

export async function getJob(id: string): Promise<Job | undefined> {
  if (memory.has(id)) return memory.get(id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  try {
    const job = normalizeStoredJob(JSON.parse(await readFile(path.join(jobDirectory, `${id}.json`), "utf8")) as Job);
    memory.set(id, job);
    return job;
  } catch { return undefined; }
}

export function toArticleSummary(job: Job): ArticleSummary | undefined {
  if (job.stage !== "complete" || !job.article || !job.episode) return undefined;
  return {
    id: job.id,
    title: job.article.title,
    dek: job.article.dek,
    readingTimeMinutes: job.article.readingTimeMinutes,
    sourceName: job.episode.sourceName,
    sourceType: job.episode.sourceType,
    imageUrl: job.episode.imageUrl,
    publishedAt: job.episode.publishedAt,
    completedAt: job.completedAt ?? job.updatedAt,
    ...(job.readAt ? { readAt: job.readAt } : {}),
  };
}

export function listReadyArticles(): ArticleSummary[] {
  return [...memory.values()]
    .map(toArticleSummary)
    .filter((article): article is ArticleSummary => Boolean(article))
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
}

export function toProcessingJobSummary(job: Job): ProcessingJobSummary | undefined {
  if (job.stage === "complete" || job.stage === "failed") return undefined;
  return {
    id: job.id,
    title: job.episode?.title ?? "Nieuwe opname",
    sourceName: job.episode?.sourceName ?? "Bron wordt opgehaald",
    imageUrl: job.episode?.imageUrl,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    createdAt: job.createdAt,
  };
}

export function listProcessingJobs(): ProcessingJobSummary[] {
  return [...memory.values()]
    .map(toProcessingJobSummary)
    .filter((job): job is ProcessingJobSummary => Boolean(job))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function setArticleRead(id: string, read: boolean): Promise<ArticleSummary> {
  const job = await getJob(id);
  if (!job) throw new Error("Opdracht niet gevonden.");
  if (job.stage !== "complete" || !job.article || !job.episode) {
    throw new Error("Dit artikel is nog niet klaar om te lezen.");
  }
  await update(job, { readAt: read ? new Date().toISOString() : undefined });
  return toArticleSummary(job)!;
}

export async function retryArticle(id: string): Promise<Job> {
  const job = await getJob(id);
  if (!job) throw new Error("Opdracht niet gevonden.");
  if (activeRuns.has(id) || pendingJobIds.has(id)) throw new Error("Deze opdracht wordt al verwerkt.");
  if (!job.transcript?.length || !job.episode) {
    throw new Error("Deze opdracht heeft geen complete transcriptie om te hergebruiken.");
  }
  await update(job, {
    stage: "writing",
    progress: 82,
    message: "Artikel opnieuw genereren met bestaand transcript",
    error: undefined,
    article: undefined,
    readAt: undefined,
  });
  jobLog(job.id, "writing", "Artikel-only retry gestart", { transcriptSegments: job.transcript.length });
  enqueueJob(job, "article");
  return job;
}

export async function resumeIncompleteJobs(): Promise<void> {
  await mkdir(jobDirectory, { recursive: true });
  const files = (await readdir(jobDirectory)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name));
  for (const file of files) {
    try {
      const job = normalizeStoredJob(JSON.parse(await readFile(path.join(jobDirectory, file), "utf8")) as Job);
      memory.set(job.id, job);
      if (job.stage === "complete" || job.stage === "failed") continue;
      const previousStage = job.stage;
      await update(job, {
        stage: "queued",
        progress: 2,
        message: "Server herstart; opdracht wordt hervat",
        error: undefined,
      });
      jobLog(job.id, "queued", "Onvoltooide opdracht na serverstart hervat", { previousStage });
      enqueueJob(job, "full");
    } catch (error) {
      console.error(`${new Date().toISOString()} ERROR Kon opgeslagen jobbestand niet herstellen · file=${JSON.stringify(file)}`, error);
    }
  }
}

function enqueueJob(job: Job, type: "full" | "article"): void {
  if (shuttingDown || activeRuns.has(job.id) || pendingJobIds.has(job.id)) return;
  pendingRuns.push({ job, type });
  pendingJobIds.add(job.id);
  queueMicrotask(drainQueue);
}

function drainQueue(): void {
  if (shuttingDown || activeRuns.size > 0) return;
  const next = pendingRuns.shift();
  if (!next) return;
  pendingJobIds.delete(next.job.id);
  if (next.type === "article") launchArticleRetry(next.job);
  else launchJob(next.job);
}

function finishRun(jobId: string): void {
  activeRuns.delete(jobId);
  drainQueue();
}

function launchJob(job: Job): void {
  if (shuttingDown || activeRuns.size > 0 || activeRuns.has(job.id)) return;
  const controller = new AbortController();
  const promise = processJob(job, controller.signal)
    .catch((error) => jobError(job.id, job.stage, error))
    .finally(() => finishRun(job.id));
  activeRuns.set(job.id, { controller, promise });
}

function launchArticleRetry(job: Job): void {
  if (shuttingDown || activeRuns.size > 0 || activeRuns.has(job.id) || !job.transcript || !job.episode) return;
  const controller = new AbortController();
  const promise = processArticleRetry(job, controller.signal)
    .catch((error) => jobError(job.id, job.stage, error))
    .finally(() => finishRun(job.id));
  activeRuns.set(job.id, { controller, promise });
}

async function processArticleRetry(job: Job, signal: AbortSignal): Promise<void> {
  try {
    const article = await generateArticle(job, job.transcript!, job.episode!, signal);
    await update(job, { article, stage: "complete", progress: 100, message: "Artikel en transcript zijn klaar", completedAt: new Date().toISOString() });
    jobLog(job.id, "complete", "Artikel-only retry afgerond", { articleTitle: article.title });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Onbekende fout";
    if (signal.aborted) {
      await update(job, { stage: "queued", progress: 82, message: "Server afgesloten; artikelretry kan worden hervat", error: undefined });
    } else {
      jobError(job.id, job.stage, error);
      await update(job, { stage: "failed", error: message, message, progress: job.progress });
    }
  }
}

export async function shutdownJobs(reason = "Server wordt afgesloten"): Promise<void> {
  shuttingDown = true;
  const active = [...activeRuns.entries()];
  console.log(`${new Date().toISOString()} INFO  Shutdown · actieve jobs=${active.length}`);
  for (const [jobId, run] of active) {
    jobLog(jobId, "shutdown", "Actief API-verzoek annuleren");
    run.controller.abort(new DOMException(reason, "AbortError"));
  }
  await Promise.allSettled(active.map(([, run]) => run.promise));
  console.log(`${new Date().toISOString()} INFO  Shutdown · alle actieve jobs gestopt en opgeslagen`);
}

async function processJob(job: Job, signal: AbortSignal): Promise<void> {
  const workspace = path.join(workDirectory, job.id);
  const mediaTarget = playbackFileForJob(job.id)!;
  const jobStartedAt = Date.now();
  try {
    await rm(workspace, { recursive: true, force: true });
    await rm(mediaTarget, { force: true });
    await mkdir(workspace, { recursive: true });
    jobLog(job.id, "resolving", "Publieke bron zoeken");
    await update(job, { stage: "resolving", progress: 8, message: "Openbare opnamebron controleren" });
    const episode = await resolveSource(job.sourceUrl, signal);
    episode.playbackUrl = `/api/jobs/${job.id}/audio`;
    jobLog(job.id, "resolving", "Opname gekoppeld", { title: episode.title, source: episode.sourceName, sourceType: episode.sourceType, durationSeconds: episode.durationSeconds });
    await update(job, { episode, progress: 18, message: "Opname gevonden" });

    const input = path.join(workspace, "source.media");
    const downloadStartedAt = Date.now();
    jobLog(job.id, "downloading", "Media downloaden");
    await update(job, { stage: "downloading", progress: 22, message: "Opname veilig downloaden" });
    const maxMegabytes = mediaLimit(episode.sourceType);
    if (episode.sourceType === "youtube") {
      await downloadYouTubeAudio(episode.sourceUrl, input, signal, { maxMegabytes });
    } else {
      await downloadMedia(episode.mediaUrl, input, signal, { maxMegabytes });
    }
    const mediaBytes = (await stat(input)).size;
    jobLog(job.id, "downloading", "Media gedownload", { megabytes: (mediaBytes / 1024 / 1024).toFixed(1), elapsedSeconds: Math.round((Date.now() - downloadStartedAt) / 1000) });
    await update(job, { progress: 28, message: "Audio uit opname halen" });
    const playbackAudio = path.join(workspace, "playback.mp3");
    await normalizeAudio(input, playbackAudio, signal);
    await update(job, { progress: 32, message: "Audio opdelen voor transcriptie" });
    const splitStartedAt = Date.now();
    jobLog(job.id, "downloading", "FFmpeg maakt transcriptiefragmenten", { chunkSeconds: audioChunkSeconds() });
    const chunks = await splitAudio(playbackAudio, workspace, signal);
    await rm(input, { force: true });
    const chunkSizes = await Promise.all(chunks.map(async (file) => ((await stat(file)).size / 1024 / 1024).toFixed(1)));
    jobLog(job.id, "downloading", "Audiofragmenten gereed", { chunks: chunks.length, sizesMb: chunkSizes.join(","), elapsedSeconds: Math.round((Date.now() - splitStartedAt) / 1000) });

    await update(job, { stage: "transcribing", progress: 36, message: `Transcriptie starten (${chunks.length} ${chunks.length === 1 ? "deel" : "delen"})` });
    const transcript = await transcribeChunks(chunks, job.language, (done, total) => {
      void update(job, { progress: 36 + Math.round((done / total) * 40), message: `Transcriptie ${done}/${total}` });
    }, (message, data) => {
      jobLog(job.id, "transcribing", message, data);
      if (message.startsWith("Nog in afwachting")) {
        const waitingSeconds = Number(data.waitingSeconds ?? 0);
        void update(job, { message: `${data.chunk}: wacht ${Math.max(1, Math.round(waitingSeconds / 60))} min. op OpenAI` });
      }
    }, signal);
    jobLog(job.id, "transcribing", "Volledige transcriptie gereed", { segments: transcript.length });
    await mkdir(mediaDirectory, { recursive: true });
    await rename(playbackAudio, mediaTarget);
    await update(job, { transcript, progress: 78, message: "Transcript compleet" });

    const article = await generateArticle(job, transcript, episode, signal);
    await update(job, { article, stage: "complete", progress: 100, message: "Artikel en transcript zijn klaar", completedAt: new Date().toISOString() });
    jobLog(job.id, "complete", "Opdracht afgerond", { elapsedSeconds: Math.round((Date.now() - jobStartedAt) / 1000), articleTitle: article.title });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Onbekende fout";
    if (signal.aborted) {
      jobLog(job.id, "shutdown", "Opdracht onderbroken en klaargezet voor hervatten");
      await update(job, { stage: "queued", progress: 2, message: "Server afgesloten; opdracht wordt na herstart hervat", error: undefined });
    } else {
      jobError(job.id, job.stage, error);
      await update(job, { stage: "failed", error: message, message, progress: job.progress });
    }
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    jobLog(job.id, job.stage, "Tijdelijke audiobestanden opgeruimd");
  }
}

async function generateArticle(job: Job, transcript: NonNullable<Job["transcript"]>, episode: NonNullable<Job["episode"]>, signal: AbortSignal) {
  await update(job, { stage: "writing", progress: 82, message: "Brongebonden blogartikel schrijven" });
  jobLog(job.id, "writing", "Brongebonden artikel genereren", { transcriptSegments: transcript.length });
  return writeArticle(transcript, {
    title: episode.title, sourceName: episode.sourceName, language: job.language, length: job.articleLength,
  }, (message, data) => {
    jobLog(job.id, "writing", message, data);
    if (message.startsWith("Nog in afwachting")) void update(job, { message: `Artikel wordt geschreven · ${Math.max(1, Math.round(Number(data.waitingSeconds ?? 0) / 60))} min. wachten` });
  }, signal);
}
