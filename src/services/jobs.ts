import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  maxArticleRetries,
  normalizeStoredJob,
  type StoredJob,
} from "./stored-jobs.js";
import { requestArticleBackup } from "./article-backups.js";
import { recordShareEvent } from "./share-analytics.js";
import { ConcurrencyGate } from "../lib/concurrency.js";
import { jobError, jobLog } from "../lib/logger.js";
import {
  audioChunkSeconds,
  downloadMedia,
  normalizeAudio,
  splitAudio,
} from "./audio.js";
import {
  assertAccountBudget,
  AccountBudgetError,
  accountLimitUsd,
  spendingLimitExempt,
  summarizeAccountBudget,
} from "./account-budget.js";
import { transcribeChunks, writeArticle } from "./openai.js";
import { resolveSource, validateSourceUrl } from "./resolver.js";
import { downloadFathomRecording } from "./fathom.js";
import { downloadYouTubeAudio } from "./youtube.js";
import type {
  AccountBudget,
  ApiRequestUsage,
  ArticleReadingPosition,
  ArticleSummary,
  Job,
  ProcessingJobSummary,
  PodcastEpisode,
} from "../types.js";

const root = path.resolve("data");
const memory = new Map<string, Job>();
const pendingWrites = new Map<string, Promise<void>>();
const activeRuns = new Map<
  string,
  { controller: AbortController; promise: Promise<void> }
>();
const pendingRuns: Array<{
  username: string;
  job: Job;
  type: "full" | "article";
}> = [];
const pendingJobIds = new Set<string>();
const articleRetryReservations = new Set<string>();
// Metadata can advance through the whole queue without waiting for OpenAI.
const metadataSlots = new ConcurrencyGate(3);
const processingSlots = new ConcurrencyGate(3);
// Downloaders can invoke FFmpeg too, so reserve the entire media preparation step.
const mediaSlots = new ConcurrencyGate(1);
let shuttingDown = false;

export class DuplicateJobError extends Error {
  constructor(public readonly existingJob: Job) {
    super(
      existingJob.stage === "complete"
        ? "Deze opname is al verwerkt. Het bestaande artikel staat in je overzicht."
        : "Deze opname wordt al verwerkt. Bekijk de bestaande opdracht in je overzicht.",
    );
    this.name = "DuplicateJobError";
  }
}

export function userDirectory(username: string): string {
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(username)) {
    throw new Error("Ongeldige gebruikersnaam.");
  }
  return path.join(root, "users", username);
}

function jobKey(username: string, id: string): string {
  return `${username}/${id}`;
}

function mediaLimit(
  sourceType: NonNullable<Job["episode"]>["sourceType"],
): number {
  const isRecording = sourceType === "google-drive" || sourceType === "fathom";
  const fallback = isRecording ? 1_500 : 500;
  const value = Number(
    isRecording
      ? (process.env.MAX_RECORDING_MB ?? fallback)
      : sourceType === "youtube"
        ? (process.env.MAX_YOUTUBE_MB ?? fallback)
        : (process.env.MAX_AUDIO_MB ?? fallback),
  );
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function playbackFileForJob(
  username: string,
  id: string,
): string | undefined {
  return /^[0-9a-f-]{36}$/i.test(id)
    ? path.join(userDirectory(username), "media", `${id}.mp3`)
    : undefined;
}

async function persist(username: string, job: Job): Promise<void> {
  const key = jobKey(username, job.id);
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  // Progress callbacks and request accounting can persist the same job concurrently.
  // A failed write is still reported to its caller; later writes may recover.
  const writing = previous
    .catch(() => undefined)
    .then(async () => {
      const jobDirectory = path.join(userDirectory(username), "jobs");
      await mkdir(jobDirectory, { recursive: true });
      job.updatedAt = new Date().toISOString();
      const destination = path.join(jobDirectory, `${job.id}.json`);
      const temporary = `${destination}.tmp`;
      await writeFile(temporary, JSON.stringify(job, null, 2));
      await rename(temporary, destination);
      memory.set(key, job);
      if (job.stage === "complete") {
        requestArticleBackup();
      }
    });
  pendingWrites.set(key, writing);
  try {
    await writing;
  } finally {
    if (pendingWrites.get(key) === writing) {
      pendingWrites.delete(key);
    }
  }
}

function accountJobs(username: string): Job[] {
  return [...memory.entries()]
    .filter(([key]) => key.startsWith(`${username}/`))
    .map(([, job]) => job);
}

export function getAccountBudget(username: string): AccountBudget {
  return summarizeAccountBudget(
    accountJobs(username),
    spendingLimitExempt(username),
  );
}

function checkAccountBudget(username: string, reservation = 0): void {
  if (!spendingLimitExempt(username)) {
    assertAccountBudget(accountJobs(username), reservation);
  }
}

async function recordApiUsage(
  username: string,
  job: Job,
  request: ApiRequestUsage,
): Promise<void> {
  if (request.status === "pending") {
    if (request.reservedCostUsd === undefined) {
      if (!spendingLimitExempt(username)) {
        throw new AccountBudgetError();
      }
      // Continue tracking new attempts for exempt accounts, including unknown
      // prices. Revoking an exemption must not make those requests historical.
      request.reservedCostUsd = accountLimitUsd;
    }
    // No await between checking and updating the in-memory reservation: parallel
    // jobs in this server cannot both consume the same remaining allowance.
    checkAccountBudget(username, request.reservedCostUsd);
  }
  const usage = job.apiUsage ?? {
    trackingStartedAt: new Date().toISOString(),
    coverage: "partial" as const,
    requests: [],
    knownEstimatedCostUsd: 0,
    unknownCostRequests: 0,
  };
  const index = usage.requests.findIndex((entry) => entry.id === request.id);
  const snapshot = structuredClone(request);
  if (index === -1) {
    usage.requests.push(snapshot);
  } else {
    usage.requests[index] = snapshot;
  }
  usage.knownEstimatedCostUsd = usage.requests.reduce(
    (total, entry) => total + (entry.cost.amount ?? 0),
    0,
  );
  usage.unknownCostRequests = usage.requests.filter(
    (entry) => entry.cost.amount === null,
  ).length;
  await update(username, job, { apiUsage: usage });
}

async function update(
  username: string,
  job: Job,
  patch: Partial<Job>,
): Promise<void> {
  if (patch.message !== undefined) {
    delete job.messageValues;
  }
  Object.assign(job, patch);
  await persist(username, job);
}

function canonicalSourceUrl(value: string): string | undefined {
  try {
    return validateSourceUrl(value).toString();
  } catch {
    return undefined;
  }
}

export function findDuplicateJob(
  jobs: Iterable<Job>,
  sourceUrl: string,
  options: Pick<Job, "language" | "articleLength">,
): Job | undefined {
  const canonicalUrl = canonicalSourceUrl(sourceUrl);
  if (!canonicalUrl) {
    return undefined;
  }
  return [...jobs]
    .filter((job) => !job.deletedAt && job.stage !== "failed")
    .sort((left, right) => {
      if (left.stage === "complete" && right.stage !== "complete") {
        return -1;
      }
      if (right.stage === "complete" && left.stage !== "complete") {
        return 1;
      }
      return right.createdAt.localeCompare(left.createdAt);
    })
    .find(
      (job) =>
        canonicalSourceUrl(job.sourceUrl) === canonicalUrl &&
        job.language === options.language &&
        job.articleLength === options.articleLength,
    );
}

export async function createJob(
  username: string,
  input: Pick<Job, "sourceUrl" | "language" | "articleLength">,
): Promise<Job> {
  const sourceUrl = validateSourceUrl(input.sourceUrl).toString();
  const prefix = `${username}/`;
  const existingJob = findDuplicateJob(
    [...memory.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, job]) => job),
    sourceUrl,
    input,
  );
  if (existingJob) {
    throw new DuplicateJobError(existingJob);
  }
  checkAccountBudget(username);
  const now = new Date().toISOString();
  const job: Job = {
    ...input,
    sourceUrl,
    id: randomUUID(),
    articleRetryAttempts: 0,
    apiUsage: {
      trackingStartedAt: new Date().toISOString(),
      coverage: "complete",
      requests: [],
      knownEstimatedCostUsd: 0,
      unknownCostRequests: 0,
    },
    stage: "queued",
    progress: 2,
    message: "job.queued",
    createdAt: now,
    updatedAt: now,
  };
  const key = jobKey(username, job.id);
  memory.set(key, job);
  try {
    await persist(username, job);
  } catch (error) {
    if (memory.get(key) === job) {
      memory.delete(key);
    }
    throw error;
  }
  jobLog(job.id, job.stage, "Opdracht aangemaakt", {
    language: job.language,
    articleLength: job.articleLength,
  });
  enqueueJob(username, job, "full");
  return job;
}

/** Called only with feed metadata resolved on the server, never with a client episode payload. */
export async function createPodcastJob(
  username: string,
  item: PodcastEpisode,
  options: Pick<Job, "language" | "articleLength">,
): Promise<Job> {
  userDirectory(username);
  const existing = [...memory.entries()].find(
    ([key, job]) =>
      key.startsWith(`${username}/`) &&
      (job.podcastEpisodeKey === item.key ||
        (job.episode?.mediaUrl === item.episode.mediaUrl &&
          job.stage !== "failed")),
  )?.[1];
  if (existing) {
    return existing;
  }
  checkAccountBudget(username);
  const now = new Date().toISOString();
  const job: Job = {
    language: options.language,
    articleLength: options.articleLength,
    id: randomUUID(),
    sourceUrl: item.episode.sourceUrl,
    podcastEpisodeKey: item.key,
    articleRetryAttempts: 0,
    apiUsage: {
      trackingStartedAt: now,
      coverage: "complete",
      requests: [],
      knownEstimatedCostUsd: 0,
      unknownCostRequests: 0,
    },
    episode: structuredClone(item.episode),
    stage: "queued",
    progress: 2,
    message: "job.queued",
    createdAt: now,
    updatedAt: now,
  };
  // Reserve before the first await, so simultaneous checks cannot enqueue duplicates.
  const key = jobKey(username, job.id);
  memory.set(key, job);
  try {
    await persist(username, job);
  } catch (error) {
    memory.delete(key);
    throw error;
  }
  enqueueJob(username, job, "full");
  return job;
}

export function podcastOutstandingCount(
  username: string,
  ids: string[],
  keys: string[] = [],
): number {
  const jobIds = new Set(ids);
  const episodeKeys = new Set(keys);
  return [...memory.entries()].filter(
    ([key, job]) =>
      key.startsWith(`${username}/`) &&
      (jobIds.has(job.id) ||
        (job.podcastEpisodeKey && episodeKeys.has(job.podcastEpisodeKey))) &&
      !job.deletedAt &&
      job.stage !== "failed" &&
      (job.stage !== "complete" || !job.readAt),
  ).length;
}

export function podcastJobStatus(username: string, ids: string[]) {
  const identities = new Set(ids);
  const jobs = [...memory.entries()]
    .filter(
      ([key, job]) => key.startsWith(`${username}/`) && identities.has(job.id),
    )
    .map(([, job]) => job);
  return {
    complete: jobs.filter((job) => job.stage === "complete").length,
    processing: jobs.filter(
      (job) => job.stage !== "complete" && job.stage !== "failed",
    ).length,
    failed: jobs
      .filter((job) => job.stage === "failed")
      .map((job) => ({
        id: job.id,
        title: job.episode?.title || "",
        error: job.error,
      })),
  };
}

async function getStoredJob(
  username: string,
  id: string,
): Promise<Job | undefined> {
  const key = jobKey(username, id);
  if (memory.has(key)) {
    return memory.get(key);
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return undefined;
  }
  try {
    const jobDirectory = path.join(userDirectory(username), "jobs");
    const job = normalizeStoredJob(
      JSON.parse(
        await readFile(path.join(jobDirectory, `${id}.json`), "utf8"),
      ) as StoredJob,
    );
    memory.set(key, job);
    return job;
  } catch {
    return undefined;
  }
}

export async function getJob(
  username: string,
  id: string,
): Promise<Job | undefined> {
  const job = await getStoredJob(username, id);
  return job?.deletedAt ? undefined : job;
}

export async function deleteArticle(
  username: string,
  id: string,
): Promise<void> {
  const job = await getStoredJob(username, id);
  if (!job) {
    throw new Error("Opdracht niet gevonden.");
  }
  if (job.deletedAt) {
    return;
  }
  if (job.stage !== "complete" || !job.article || !job.episode) {
    throw new Error("Dit artikel is nog niet klaar om te verwijderen.");
  }
  await persist(username, { ...job, deletedAt: new Date().toISOString() });
}

export function toArticleSummary(job: Job): ArticleSummary | undefined {
  if (
    job.deletedAt ||
    job.stage !== "complete" ||
    !job.article ||
    !job.episode
  ) {
    return undefined;
  }
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

export function compareArticleSummaries(
  left: ArticleSummary,
  right: ArticleSummary,
): number {
  if (left.readAt && right.readAt) {
    return right.readAt.localeCompare(left.readAt);
  }
  if (left.readAt) {
    return 1;
  }
  if (right.readAt) {
    return -1;
  }
  return right.completedAt.localeCompare(left.completedAt);
}

export function listReadyArticles(username: string): ArticleSummary[] {
  const prefix = `${username}/`;
  return [...memory.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, job]) => job)
    .map(toArticleSummary)
    .filter((article): article is ArticleSummary => Boolean(article))
    .sort(compareArticleSummaries);
}

export function toProcessingJobSummary(
  job: Job,
): ProcessingJobSummary | undefined {
  if (job.deletedAt || job.stage === "complete" || job.stage === "failed") {
    return undefined;
  }
  return {
    id: job.id,
    title: job.episode?.title ?? "Nieuwe opname",
    sourceName: job.episode?.sourceName ?? "Bron wordt opgehaald",
    imageUrl: job.episode?.imageUrl,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    messageValues: job.messageValues,
    createdAt: job.createdAt,
  };
}

export function listProcessingJobs(username: string): ProcessingJobSummary[] {
  const prefix = `${username}/`;
  return [...memory.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, job]) => job)
    .map(toProcessingJobSummary)
    .filter((job): job is ProcessingJobSummary => Boolean(job))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function setArticleRead(
  username: string,
  id: string,
  read: boolean,
): Promise<ArticleSummary> {
  const job = await getJob(username, id);
  if (!job) {
    throw new Error("Opdracht niet gevonden.");
  }
  if (job.stage !== "complete" || !job.article || !job.episode) {
    throw new Error("Dit artikel is nog niet klaar om te lezen.");
  }
  await update(username, job, {
    readAt: read ? new Date().toISOString() : undefined,
  });
  return toArticleSummary(job)!;
}

export async function setArticleReadingPosition(
  username: string,
  id: string,
  sectionIndex: number,
): Promise<ArticleReadingPosition> {
  const job = await getJob(username, id);
  if (!job) {
    throw new Error("Opdracht niet gevonden.");
  }
  if (job.stage !== "complete" || !job.article || !job.episode) {
    throw new Error("Dit artikel is nog niet klaar om te lezen.");
  }
  if (
    !Number.isInteger(sectionIndex) ||
    sectionIndex < 0 ||
    sectionIndex >= job.article.sections.length
  ) {
    throw new Error("Deze leespositie bestaat niet in het artikel.");
  }
  const readingPosition = {
    sectionIndex,
    updatedAt: new Date().toISOString(),
  } satisfies ArticleReadingPosition;
  await update(username, job, { readingPosition });
  return readingPosition;
}

function isShareToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export async function createArticleShare(
  username: string,
  id: string,
): Promise<string> {
  const job = await getJob(username, id);
  if (!job) {
    throw new Error("Opdracht niet gevonden.");
  }
  if (
    job.stage !== "complete" ||
    !job.article ||
    !job.episode ||
    !job.transcript
  ) {
    throw new Error("Dit artikel is nog niet klaar om te delen.");
  }
  if (!job.shareToken || !isShareToken(job.shareToken)) {
    const shareToken = randomBytes(32).toString("base64url");
    await update(username, job, { shareToken });
    return shareToken;
  }
  return job.shareToken;
}

export function getSharedArticle(
  token: string,
): { username: string; job: Job } | undefined {
  if (!isShareToken(token)) {
    return undefined;
  }
  for (const [key, job] of memory.entries()) {
    if (
      job.shareToken === token &&
      !job.deletedAt &&
      job.stage === "complete" &&
      job.article &&
      job.episode &&
      job.transcript
    ) {
      return { username: key.slice(0, key.indexOf("/")), job };
    }
  }
  return undefined;
}

export async function recordSharedArticleEvent(
  token: string,
  visitId: string,
  event: "load" | "read",
): Promise<boolean> {
  const shared = getSharedArticle(token);
  if (!shared) {
    return false;
  }
  const shareAnalytics = recordShareEvent(
    shared.job.shareAnalytics,
    visitId,
    event,
  );
  if (!shareAnalytics) {
    return false;
  }
  if (shareAnalytics !== shared.job.shareAnalytics) {
    await update(shared.username, shared.job, { shareAnalytics });
  }
  return true;
}

function savedShareKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function findSavedSharedArticle(
  username: string,
  token: string,
): Job | undefined {
  const shared = getSharedArticle(token);
  if (shared?.username === username) {
    return shared.job;
  }
  const key = savedShareKey(token);
  return [...memory.entries()].find(
    ([entry, job]) =>
      entry.startsWith(`${username}/`) &&
      !job.deletedAt &&
      job.savedShareKey === key,
  )?.[1];
}

const pendingSaves = new Map<string, Promise<Job>>();

export async function saveSharedArticle(
  username: string,
  token: string,
): Promise<Job> {
  userDirectory(username);
  const key = jobKey(username, savedShareKey(token));
  const pending = pendingSaves.get(key);
  if (pending) {
    return pending;
  }
  const operation = copySharedArticle(username, token);
  pendingSaves.set(key, operation);
  try {
    return await operation;
  } finally {
    pendingSaves.delete(key);
  }
}

async function copySharedArticle(
  username: string,
  token: string,
): Promise<Job> {
  const shared = getSharedArticle(token);
  if (!shared?.job.article || !shared.job.episode || !shared.job.transcript) {
    throw new Error("Gedeeld artikel niet gevonden.");
  }
  const existing = findSavedSharedArticle(username, token);
  if (existing) {
    return existing;
  }
  const { job: source } = shared;
  const episode = shared.job.episode;
  const id = randomUUID();
  const now = new Date().toISOString();
  // Copy only what the capability already exposes, never the owner's job or transcript.
  const job: Job = {
    id,
    sourceUrl: episode.sourceUrl,
    language: source.language,
    articleLength: source.articleLength,
    stage: "complete",
    progress: 100,
    message: "job.complete",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    savedShareKey: savedShareKey(token),
    article: structuredClone(shared.job.article),
    episode: {
      sourceType: episode.sourceType,
      sourceUrl: episode.sourceUrl,
      sourceName: episode.sourceName,
      title: episode.title,
      imageUrl: episode.imageUrl,
      durationSeconds: episode.durationSeconds,
      publishedAt: episode.publishedAt,
      mediaUrl: "",
      playbackUrl: `/api/jobs/${id}/audio`,
    },
    transcript: shared.job.transcript.map(({ id, start }) => ({
      id,
      start,
      end: start,
      speaker: "",
      text: "",
    })),
  };
  const sourceAudio = playbackFileForJob(shared.username, source.id);
  const targetAudio = playbackFileForJob(username, id);
  if (!sourceAudio || !targetAudio) {
    throw new Error("Gedeeld artikel niet gevonden.");
  }
  await mkdir(path.dirname(targetAudio), { recursive: true });
  try {
    await copyFile(sourceAudio, targetAudio);
  } catch (error) {
    // Articles without retained audio can still be saved and read.
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
  try {
    await persist(username, job);
  } catch (error) {
    await rm(targetAudio, { force: true });
    throw error;
  }
  return job;
}

export async function retryArticle(username: string, id: string): Promise<Job> {
  const key = jobKey(username, id);
  if (articleRetryReservations.has(key)) {
    throw new Error("Deze opdracht wordt al verwerkt.");
  }
  articleRetryReservations.add(key);
  try {
    const job = await getJob(username, id);
    if (!job) {
      throw new Error("Opdracht niet gevonden.");
    }
    if (activeRuns.has(key) || pendingJobIds.has(key)) {
      throw new Error("Deze opdracht wordt al verwerkt.");
    }
    if (job.savedShareKey || !job.transcript?.length || !job.episode) {
      throw new Error(
        "Deze opdracht heeft geen complete transcriptie om te hergebruiken.",
      );
    }
    if (job.stage !== "failed") {
      throw new Error(
        "Alleen mislukte opdrachten kunnen opnieuw worden geprobeerd.",
      );
    }
    const attempts = job.articleRetryAttempts ?? 0;
    if (attempts >= maxArticleRetries) {
      throw new Error(
        "Deze opdracht heeft het maximum van twee artikelpogingen bereikt.",
      );
    }
    checkAccountBudget(username);
    const retryJob: Job = {
      ...job,
      stage: "writing",
      progress: 82,
      message: "job.regenerating",
      messageValues: undefined,
      error: undefined,
      article: undefined,
      readAt: undefined,
      readingPosition: undefined,
      articleRetryAttempts: attempts + 1,
    };
    // Persist the allowance before paid work starts; failed writes leave the
    // original in-memory job intact. The reservation also covers cold reads.
    await persist(username, retryJob);
    jobLog(job.id, "writing", "Artikel-only retry gestart", {
      transcriptSegments: job.transcript.length,
      attempt: retryJob.articleRetryAttempts,
    });
    enqueueJob(username, retryJob, "article");
    return retryJob;
  } finally {
    articleRetryReservations.delete(key);
  }
}

export async function resumeIncompleteJobs(usernames: string[]): Promise<void> {
  const recovered: Array<{ username: string; job: Job }> = [];
  for (const username of usernames) {
    const jobDirectory = path.join(userDirectory(username), "jobs");
    await mkdir(jobDirectory, { recursive: true });
    const files = (await readdir(jobDirectory)).filter((name) =>
      /^[0-9a-f-]{36}\.json$/i.test(name),
    );
    for (const file of files) {
      try {
        const job = normalizeStoredJob(
          JSON.parse(
            await readFile(path.join(jobDirectory, file), "utf8"),
          ) as StoredJob,
        );
        memory.set(jobKey(username, job.id), job);
        if (
          job.deletedAt ||
          job.stage === "complete" ||
          job.stage === "failed"
        ) {
          continue;
        }
        const previousStage = job.stage;
        await update(username, job, {
          stage: "queued",
          progress: 2,
          message: "job.resuming",
          error: undefined,
        });
        jobLog(job.id, "queued", "Onvoltooide opdracht na serverstart hervat", {
          previousStage,
        });
        recovered.push({ username, job });
      } catch (error) {
        console.error(
          `${new Date().toISOString()} ERROR Kon opgeslagen jobbestand niet herstellen · file=${JSON.stringify(file)}`,
          error,
        );
        throw error;
      }
    }
  }
  for (const { username, job } of recovered) {
    enqueueJob(username, job, "full");
  }
}

function enqueueJob(
  username: string,
  job: Job,
  type: "full" | "article",
): void {
  const key = jobKey(username, job.id);
  if (shuttingDown || activeRuns.has(key) || pendingJobIds.has(key)) {
    return;
  }
  pendingRuns.push({ username, job, type });
  pendingJobIds.add(key);
  queueMicrotask(drainQueue);
}

function drainQueue(): void {
  while (!shuttingDown && pendingRuns.length > 0) {
    const next = pendingRuns.shift();
    if (!next) {
      return;
    }
    pendingJobIds.delete(jobKey(next.username, next.job.id));
    if (next.type === "article") {
      launchArticleRetry(next.username, next.job);
    } else {
      launchJob(next.username, next.job);
    }
  }
}

function finishRun(jobId: string): void {
  activeRuns.delete(jobId);
  drainQueue();
}

function launchJob(username: string, job: Job): void {
  const key = jobKey(username, job.id);
  if (shuttingDown || activeRuns.has(key)) {
    return;
  }
  const controller = new AbortController();
  const promise = processJob(username, job, controller.signal)
    .catch((error) => jobError(job.id, job.stage, error))
    .finally(() => finishRun(key));
  activeRuns.set(key, { controller, promise });
}

function launchArticleRetry(username: string, job: Job): void {
  const key = jobKey(username, job.id);
  if (shuttingDown || activeRuns.has(key) || !job.transcript || !job.episode) {
    return;
  }
  const controller = new AbortController();
  const promise = processArticleRetry(username, job, controller.signal)
    .catch((error) => jobError(job.id, job.stage, error))
    .finally(() => finishRun(key));
  activeRuns.set(key, { controller, promise });
}

async function processArticleRetry(
  username: string,
  job: Job,
  signal: AbortSignal,
): Promise<void> {
  let releaseProcessing: (() => void) | undefined;
  try {
    releaseProcessing = await processingSlots.acquire(signal);
    const article = await generateArticle(
      username,
      job,
      job.transcript!,
      job.episode!,
      signal,
    );
    await update(username, job, {
      article,
      stage: "complete",
      progress: 100,
      message: "job.complete",
      completedAt: new Date().toISOString(),
    });
    jobLog(job.id, "complete", "Artikel-only retry afgerond", {
      articleTitle: article.title,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Onbekende fout";
    if (signal.aborted) {
      await update(username, job, {
        stage: "queued",
        progress: 82,
        message: "job.retryPaused",
        error: undefined,
      });
    } else {
      jobError(job.id, job.stage, error);
      await update(username, job, {
        stage: "failed",
        error: message,
        message,
        progress: job.progress,
      });
    }
  } finally {
    releaseProcessing?.();
  }
}

export async function shutdownJobs(
  reason = "Server wordt afgesloten",
): Promise<void> {
  shuttingDown = true;
  const active = [...activeRuns.entries()];
  console.log(
    `${new Date().toISOString()} INFO  Shutdown · actieve jobs=${active.length}`,
  );
  for (const [jobId, run] of active) {
    jobLog(jobId, "shutdown", "Actief API-verzoek annuleren");
    run.controller.abort(new DOMException(reason, "AbortError"));
  }
  await Promise.allSettled(active.map(([, run]) => run.promise));
  console.log(
    `${new Date().toISOString()} INFO  Shutdown · alle actieve jobs gestopt en opgeslagen`,
  );
}

async function processJob(
  username: string,
  job: Job,
  signal: AbortSignal,
): Promise<void> {
  const workDirectory = path.join(userDirectory(username), "work");
  const mediaDirectory = path.join(userDirectory(username), "media");
  const workspace = path.join(workDirectory, job.id);
  const mediaTarget = playbackFileForJob(username, job.id)!;
  const jobStartedAt = Date.now();
  let releaseProcessing: (() => void) | undefined;
  let releaseMedia: (() => void) | undefined;
  try {
    await rm(workspace, { recursive: true, force: true });
    await rm(mediaTarget, { force: true });
    await mkdir(workspace, { recursive: true });
    jobLog(job.id, "resolving", "Publieke bron zoeken");
    await update(username, job, {
      stage: "resolving",
      progress: 8,
      message: "job.checkingSource",
    });
    let episode: NonNullable<Job["episode"]>;
    if (job.podcastEpisodeKey && job.episode) {
      episode = structuredClone(job.episode);
    } else {
      const releaseMetadata = await metadataSlots.acquire(signal);
      try {
        episode = await resolveSource(job.sourceUrl, signal);
      } finally {
        releaseMetadata();
      }
    }
    episode.playbackUrl = `/api/jobs/${job.id}/audio`;
    jobLog(job.id, "resolving", "Opname gekoppeld", {
      title: episode.title,
      source: episode.sourceName,
      sourceType: episode.sourceType,
      durationSeconds: episode.durationSeconds,
    });
    await update(username, job, {
      episode,
      stage: "queued",
      progress: 18,
      message: "job.sourceFound",
    });

    releaseProcessing = await processingSlots.acquire(signal);
    releaseMedia = await mediaSlots.acquire(signal);

    const input = path.join(workspace, "source.media");
    const downloadStartedAt = Date.now();
    jobLog(job.id, "downloading", "Media downloaden");
    await update(username, job, {
      stage: "downloading",
      progress: 22,
      message: "job.downloading",
    });
    const maxMegabytes = mediaLimit(episode.sourceType);
    if (episode.sourceType === "youtube") {
      await downloadYouTubeAudio(episode.sourceUrl, input, signal, {
        maxMegabytes,
      });
    } else if (episode.sourceType === "fathom") {
      await downloadFathomRecording(episode.sourceUrl, input, signal, {
        maxMegabytes,
      });
    } else {
      await downloadMedia(episode.mediaUrl, input, signal, { maxMegabytes });
    }
    const mediaBytes = (await stat(input)).size;
    jobLog(job.id, "downloading", "Media gedownload", {
      megabytes: (mediaBytes / 1024 / 1024).toFixed(1),
      elapsedSeconds: Math.round((Date.now() - downloadStartedAt) / 1000),
    });
    await update(username, job, {
      progress: 28,
      message: "job.extractingAudio",
    });
    const playbackAudio = path.join(workspace, "playback.mp3");
    await normalizeAudio(input, playbackAudio, signal);
    await update(username, job, {
      progress: 32,
      message: "job.splittingAudio",
    });
    const splitStartedAt = Date.now();
    jobLog(job.id, "downloading", "FFmpeg maakt transcriptiefragmenten", {
      chunkSeconds: audioChunkSeconds(),
    });
    const chunks = await splitAudio(playbackAudio, workspace, signal);
    releaseMedia();
    releaseMedia = undefined;
    await rm(input, { force: true });
    const chunkSizes = await Promise.all(
      chunks.map(async (file) =>
        ((await stat(file)).size / 1024 / 1024).toFixed(1),
      ),
    );
    jobLog(job.id, "downloading", "Audiofragmenten gereed", {
      chunks: chunks.length,
      sizesMb: chunkSizes.join(","),
      elapsedSeconds: Math.round((Date.now() - splitStartedAt) / 1000),
    });

    await update(username, job, {
      stage: "transcribing",
      progress: 36,
      message: "progress.start",
      messageValues: { parts: chunks.length },
    });
    const transcript = await transcribeChunks(
      chunks,
      job.language,
      (done, total) => {
        void update(username, job, {
          progress: 36 + Math.round((done / total) * 40),
          message: "progress.transcription",
          messageValues: { done, total },
        });
      },
      (message, data) => {
        jobLog(job.id, "transcribing", message, data);
        if (message.startsWith("Nog in afwachting")) {
          const waitingSeconds = Number(data.waitingSeconds ?? 0);
          void update(username, job, {
            message: "progress.wait",
            messageValues: {
              chunk: String(data.chunk),
              minutes: Math.max(1, Math.round(waitingSeconds / 60)),
            },
          });
        }
      },
      signal,
      (request) => recordApiUsage(username, job, request),
    );
    jobLog(job.id, "transcribing", "Volledige transcriptie gereed", {
      segments: transcript.length,
    });
    await mkdir(mediaDirectory, { recursive: true });
    await rename(playbackAudio, mediaTarget);
    await update(username, job, {
      transcript,
      progress: 78,
      message: "job.transcriptComplete",
    });

    const article = await generateArticle(
      username,
      job,
      transcript,
      episode,
      signal,
    );
    await update(username, job, {
      article,
      stage: "complete",
      progress: 100,
      message: "job.complete",
      completedAt: new Date().toISOString(),
    });
    jobLog(job.id, "complete", "Opdracht afgerond", {
      elapsedSeconds: Math.round((Date.now() - jobStartedAt) / 1000),
      articleTitle: article.title,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Onbekende fout";
    if (signal.aborted) {
      jobLog(
        job.id,
        "shutdown",
        "Opdracht onderbroken en klaargezet voor hervatten",
      );
      await update(username, job, {
        stage: "queued",
        progress: 2,
        message: "job.paused",
        error: undefined,
      });
    } else {
      jobError(job.id, job.stage, error);
      await update(username, job, {
        stage: "failed",
        error: message,
        message,
        progress: job.progress,
      });
    }
  } finally {
    releaseMedia?.();
    await rm(workspace, { recursive: true, force: true }).catch(
      () => undefined,
    );
    releaseProcessing?.();
    jobLog(job.id, job.stage, "Tijdelijke audiobestanden opgeruimd");
  }
}

async function generateArticle(
  username: string,
  job: Job,
  transcript: NonNullable<Job["transcript"]>,
  episode: NonNullable<Job["episode"]>,
  signal: AbortSignal,
) {
  await update(username, job, {
    stage: "writing",
    progress: 82,
    message: "job.writing",
  });
  jobLog(job.id, "writing", "Brongebonden artikel genereren", {
    transcriptSegments: transcript.length,
  });
  return writeArticle(
    transcript,
    {
      title: episode.title,
      sourceName: episode.sourceName,
      language: job.language,
      length: job.articleLength,
    },
    (message, data) => {
      jobLog(job.id, "writing", message, data);
      if (message.startsWith("Nog in afwachting")) {
        void update(username, job, {
          message: "progress.writing",
          messageValues: {
            minutes: Math.max(
              1,
              Math.round(Number(data.waitingSeconds ?? 0) / 60),
            ),
          },
        });
      }
    },
    signal,
    (request) => recordApiUsage(username, job, request),
  );
}
