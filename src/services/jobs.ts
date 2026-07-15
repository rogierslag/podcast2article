import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { jobError, jobLog } from "../lib/logger.js";
import { audioChunkSeconds, downloadAudio, splitAudio } from "./audio.js";
import { transcribeChunks, writeArticle } from "./openai.js";
import { resolveSpotifyEpisode } from "./resolver.js";
import type { Job } from "../types.js";

const root = path.resolve("data");
const jobDirectory = path.join(root, "jobs");
const workDirectory = path.join(root, "work");
const memory = new Map<string, Job>();
const activeRuns = new Map<string, { controller: AbortController; promise: Promise<void> }>();

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

export async function createJob(input: Pick<Job, "spotifyUrl" | "language" | "articleLength">): Promise<Job> {
  const now = new Date().toISOString();
  const job: Job = {
    ...input,
    id: randomUUID(),
    stage: "queued",
    progress: 2,
    message: "Opdracht staat klaar",
    createdAt: now,
    updatedAt: now,
  };
  await persist(job);
  jobLog(job.id, job.stage, "Opdracht aangemaakt", { language: job.language, articleLength: job.articleLength });
  queueMicrotask(() => launchJob(job));
  return job;
}

export async function getJob(id: string): Promise<Job | undefined> {
  if (memory.has(id)) return memory.get(id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  try {
    const job = JSON.parse(await readFile(path.join(jobDirectory, `${id}.json`), "utf8")) as Job;
    memory.set(id, job);
    return job;
  } catch { return undefined; }
}

export async function retryArticle(id: string): Promise<Job> {
  const job = await getJob(id);
  if (!job) throw new Error("Opdracht niet gevonden.");
  if (activeRuns.has(id)) throw new Error("Deze opdracht wordt al verwerkt.");
  if (!job.transcript?.length || !job.episode) {
    throw new Error("Deze opdracht heeft geen complete transcriptie om te hergebruiken.");
  }
  await update(job, {
    stage: "writing",
    progress: 82,
    message: "Artikel opnieuw genereren met bestaand transcript",
    error: undefined,
    article: undefined,
  });
  jobLog(job.id, "writing", "Artikel-only retry gestart", { transcriptSegments: job.transcript.length });
  queueMicrotask(() => launchArticleRetry(job));
  return job;
}

export async function resumeIncompleteJobs(): Promise<void> {
  await mkdir(jobDirectory, { recursive: true });
  const files = (await readdir(jobDirectory)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name));
  for (const file of files) {
    try {
      const job = JSON.parse(await readFile(path.join(jobDirectory, file), "utf8")) as Job;
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
      queueMicrotask(() => launchJob(job));
    } catch (error) {
      console.error(`${new Date().toISOString()} ERROR Kon opgeslagen jobbestand niet herstellen · file=${JSON.stringify(file)}`, error);
    }
  }
}

function launchJob(job: Job): void {
  if (activeRuns.has(job.id)) return;
  const controller = new AbortController();
  const promise = processJob(job, controller.signal)
    .catch((error) => jobError(job.id, job.stage, error))
    .finally(() => activeRuns.delete(job.id));
  activeRuns.set(job.id, { controller, promise });
}

function launchArticleRetry(job: Job): void {
  if (activeRuns.has(job.id) || !job.transcript || !job.episode) return;
  const controller = new AbortController();
  const promise = processArticleRetry(job, controller.signal)
    .catch((error) => jobError(job.id, job.stage, error))
    .finally(() => activeRuns.delete(job.id));
  activeRuns.set(job.id, { controller, promise });
}

async function processArticleRetry(job: Job, signal: AbortSignal): Promise<void> {
  try {
    const article = await generateArticle(job, job.transcript!, job.episode!, signal);
    await update(job, { article, stage: "complete", progress: 100, message: "Artikel en transcript zijn klaar" });
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
  const jobStartedAt = Date.now();
  try {
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    jobLog(job.id, "resolving", "Publieke bron zoeken");
    await update(job, { stage: "resolving", progress: 8, message: "Openbare podcastbron zoeken" });
    const episode = await resolveSpotifyEpisode(job.spotifyUrl);
    jobLog(job.id, "resolving", "Aflevering gekoppeld", { title: episode.title, podcast: episode.podcast, durationSeconds: episode.durationSeconds });
    await update(job, { episode, progress: 18, message: "Aflevering gevonden" });

    const input = path.join(workspace, "episode.audio");
    const downloadStartedAt = Date.now();
    jobLog(job.id, "downloading", "Audio downloaden");
    await update(job, { stage: "downloading", progress: 22, message: "Audio veilig downloaden" });
    await downloadAudio(episode.audioUrl, input, signal);
    const audioBytes = (await stat(input)).size;
    jobLog(job.id, "downloading", "Audio gedownload", { megabytes: (audioBytes / 1024 / 1024).toFixed(1), elapsedSeconds: Math.round((Date.now() - downloadStartedAt) / 1000) });
    await update(job, { progress: 32, message: "Audio opdelen voor transcriptie" });
    const splitStartedAt = Date.now();
    jobLog(job.id, "downloading", "FFmpeg maakt transcriptiefragmenten", { chunkSeconds: audioChunkSeconds() });
    const chunks = await splitAudio(input, workspace, signal);
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
    await update(job, { transcript, progress: 78, message: "Transcript compleet" });

    const article = await generateArticle(job, transcript, episode, signal);
    await update(job, { article, stage: "complete", progress: 100, message: "Artikel en transcript zijn klaar" });
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
    title: episode.title, podcast: episode.podcast, language: job.language, length: job.articleLength,
  }, (message, data) => {
    jobLog(job.id, "writing", message, data);
    if (message.startsWith("Nog in afwachting")) void update(job, { message: `Artikel wordt geschreven · ${Math.max(1, Math.round(Number(data.waitingSeconds ?? 0) / 60))} min. wachten` });
  }, signal);
}
