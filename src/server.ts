import express from "express";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveGitSha } from "./lib/git.js";
import {
  localizeJob,
  localizeProcessingJob,
  localizeTemplate,
  requestLanguage,
  translateStoredMessage,
} from "./lib/i18n.js";
import { translate } from "../public/i18n.js";
import {
  createUserAuth,
  expiredSessionCookie,
  readCookie,
  SESSION_COOKIE_NAME,
  sessionCookie,
} from "./services/auth.js";
import {
  createArticleShare,
  createJob,
  DuplicateJobError,
  deleteArticle,
  getJob,
  getSharedArticle,
  listProcessingJobs,
  listReadyArticles,
  playbackFileForJob,
  resumeIncompleteJobs,
  retryArticle,
  setArticleRead,
  setArticleReadingPosition,
  shutdownJobs,
} from "./services/jobs.js";
import { generateArticlePdf, pdfDownloadName } from "./services/pdf.js";
import { validateSourceUrl } from "./services/resolver.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST?.trim() || "127.0.0.1";
const publicDirectory = path.resolve("public");
const gitSha = await resolveGitSha();
const loginTemplate = await readFile(
  path.join(publicDirectory, "login.html"),
  "utf8",
);
const auth = createUserAuth();
const loginAttempts = new Map<
  string,
  { failures: number; blockedUntil: number }
>();
const maximumLoginFailures = 5;
const loginBlockMs = 15 * 60 * 1_000;

app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use((_request, response, next) => {
  // Cached responses must not mix UI languages between visitors.
  response.vary("Accept-Language");
  next();
});
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "2kb" }));

function responseLanguage(response: express.Response) {
  return requestLanguage(response.req.get("Accept-Language"));
}

function localizeError(
  response: express.Response,
  message: unknown,
  fallback = "error.generic",
): string {
  return translateStoredMessage(responseLanguage(response), message, fallback);
}

function renderPage(response: express.Response, template: string): string {
  const language = responseLanguage(response);
  response.setHeader("Content-Language", language);
  return localizeTemplate(template, language);
}

async function sendIndex(
  _request: express.Request,
  response: express.Response,
) {
  response.setHeader("Cache-Control", "no-store");
  response.type("html");
  return response.send(
    renderPage(
      response,
      await readFile(path.join(publicDirectory, "index.html"), "utf8"),
    ),
  );
}

function authenticatedUser(
  cookieHeader: string | undefined,
): string | undefined {
  return auth.enabled
    ? auth.sessionUser(readCookie(cookieHeader, SESSION_COOKIE_NAME))
    : "local";
}

function publicOrigin(request: express.Request): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  return configured || `${request.protocol}://${request.get("host")}`;
}

function htmlAttribute(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

function loginBuildMarkup(response: express.Response): string {
  if (!gitSha) {
    return "";
  }
  const shortSha = gitSha.slice(0, 7);
  const language = responseLanguage(response);
  return `<p class="build-sha" data-build-sha="${gitSha}" aria-label="${translate(language, "build.label", { sha: gitSha })}">${translate(language, "build", { sha: shortSha })}</p>`;
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/s/:token", async (request, response) => {
  const shared = getSharedArticle(request.params.token);
  if (!shared) {
    response.type("html");
    return response
      .status(404)
      .send(
        renderPage(
          response,
          await readFile(
            path.join(publicDirectory, "share-not-found.html"),
            "utf8",
          ),
        ),
      );
  }
  const { job } = shared;
  const url = `${publicOrigin(request)}/s/${request.params.token}`;
  const title = job.article!.title;
  const description = job.article!.dek;
  const image = job.episode!.imageUrl;
  const metadata = [
    `<title>${htmlAttribute(title)} — Podcast2Article</title>`,
    `<meta name="description" content="${htmlAttribute(description)}">`,
    `<link rel="canonical" href="${htmlAttribute(url)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="Podcast2Article">`,
    `<meta property="og:title" content="${htmlAttribute(title)}">`,
    `<meta property="og:description" content="${htmlAttribute(description)}">`,
    `<meta property="og:url" content="${htmlAttribute(url)}">`,
    `<meta property="article:published_time" content="${htmlAttribute(job.completedAt ?? job.updatedAt)}">`,
    ...(image
      ? [
          `<meta property="og:image" content="${htmlAttribute(image)}">`,
          `<meta property="og:image:alt" content="${htmlAttribute(job.episode!.title)}">`,
          `<meta name="twitter:card" content="summary_large_image">`,
          `<meta name="twitter:image" content="${htmlAttribute(image)}">`,
          `<meta name="twitter:image:alt" content="${htmlAttribute(job.episode!.title)}">`,
        ]
      : [`<meta name="twitter:card" content="summary">`]),
    `<meta name="twitter:title" content="${htmlAttribute(title)}">`,
    `<meta name="twitter:description" content="${htmlAttribute(description)}">`,
  ].join("\n  ");
  const template = await readFile(
    path.join(publicDirectory, "share.html"),
    "utf8",
  );
  response.setHeader("Cache-Control", "public, max-age=300");
  response.type("html");
  return response.send(
    renderPage(response, template).replace("<!-- SHARE_METADATA -->", metadata),
  );
});

app.get("/api/shared/:token", (request, response) => {
  const shared = getSharedArticle(request.params.token);
  if (!shared) {
    return response.status(404).json({
      error: localizeError(response, "error.sharedNotFound"),
    });
  }
  const { job } = shared;
  response.setHeader("Cache-Control", "public, max-age=300");
  return response.json({
    article: job.article,
    sources: job.transcript!.map(({ id, start }) => ({ id, start })),
    episode: {
      sourceType: job.episode!.sourceType,
      sourceUrl: job.episode!.sourceUrl,
      sourceName: job.episode!.sourceName,
      title: job.episode!.title,
      imageUrl: job.episode!.imageUrl,
      durationSeconds: job.episode!.durationSeconds,
      publishedAt: job.episode!.publishedAt,
    },
  });
});

app.get("/api/shared/:token/audio", async (request, response) => {
  const shared = getSharedArticle(request.params.token);
  if (!shared) {
    return response
      .status(404)
      .json({ error: localizeError(response, "error.audioNotFound") });
  }
  const file = playbackFileForJob(shared.username, shared.job.id);
  if (!file) {
    return response
      .status(404)
      .json({ error: localizeError(response, "error.audioNotFound") });
  }
  try {
    const fileStats = await stat(file);
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.setHeader("Content-Length", fileStats.size);
    response.type("audio/mpeg");
    return createReadStream(file).pipe(response);
  } catch {
    return response
      .status(404)
      .json({ error: localizeError(response, "error.audioNotFound") });
  }
});

app.get(
  [
    "/share.js",
    "/i18n.js",
    "/localize.js",
    "/share.css",
    "/styles.css",
    "/favicon.svg",
    "/favicon-32.png",
    "/apple-touch-icon.png",
  ],
  async (request, response) => {
    const contentTypes: Record<string, string> = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    response.type(
      contentTypes[path.extname(request.path)] ?? "application/octet-stream",
    );
    return response.send(
      await readFile(path.join(publicDirectory, request.path)),
    );
  },
);

app.get("/login", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (authenticatedUser(request.headers.cookie)) {
    return response.redirect(303, "/");
  }
  response.type("html");
  return response.send(
    renderPage(response, loginTemplate).replace(
      "<!-- GIT_SHA -->",
      loginBuildMarkup(response),
    ),
  );
});

app.post("/login", (request, response) => {
  if (!auth.enabled) {
    return response.redirect(303, "/");
  }
  const key = request.ip ?? request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const storedAttempt = loginAttempts.get(key);
  const attempt =
    storedAttempt &&
    (storedAttempt.blockedUntil === 0 || storedAttempt.blockedUntil > now)
      ? storedAttempt
      : undefined;
  if (storedAttempt && !attempt) {
    loginAttempts.delete(key);
  }
  if (attempt && attempt.blockedUntil > Date.now()) {
    response.setHeader(
      "Retry-After",
      String(Math.ceil((attempt.blockedUntil - Date.now()) / 1_000)),
    );
    return response
      .status(429)
      .send(localizeError(response, "error.loginRateLimit"));
  }
  const username =
    typeof request.body?.username === "string"
      ? request.body.username.trim().toLowerCase()
      : "";
  const password =
    typeof request.body?.password === "string" ? request.body.password : "";
  const token = auth.authenticate(username, password);
  if (!token) {
    const failures = (attempt?.failures ?? 0) + 1;
    loginAttempts.set(key, {
      failures,
      blockedUntil:
        failures >= maximumLoginFailures ? Date.now() + loginBlockMs : 0,
    });
    return response.redirect(303, "/login?error=1");
  }
  loginAttempts.delete(key);
  response.setHeader("Set-Cookie", sessionCookie(token, request.secure));
  return response.redirect(303, "/");
});

app.use((request, response, next) => {
  const username = authenticatedUser(request.headers.cookie);
  if (username) {
    response.locals.username = username;
    return next();
  }
  response.setHeader("Cache-Control", "no-store");
  if (request.path.startsWith("/api/")) {
    return response.status(401).json({
      error: localizeError(response, "error.loginRequired"),
    });
  }
  return request.method === "GET"
    ? response.redirect(303, "/login")
    : response.status(401).send(localizeError(response, "error.loginRequired"));
});

app.post("/logout", (request, response) => {
  response.setHeader("Set-Cookie", expiredSessionCookie(request.secure));
  return response.redirect(303, "/login");
});

app.get("/api/auth", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ enabled: auth.enabled, username: response.locals.username });
});

app.get(["/", "/index.html", "/articles"], sendIndex);
app.use((request, response, next) => {
  // HTML files are templates, never serve their untranslated placeholders as static assets.
  if (request.path.endsWith(".html")) {
    return sendIndex(request, response);
  }
  next();
});
app.use(express.static(publicDirectory, { index: false }));

const requestSchema = z
  .object({
    sourceUrl: z.string().url().max(500).optional(),
    /** Accepted for API compatibility with clients from before generic sources. */
    spotifyUrl: z.string().url().max(500).optional(),
    language: z.enum(["auto", "nl", "en", "de", "fr", "es"]).default("auto"),
    articleLength: z.enum(["compact", "standard", "long"]).default("standard"),
  })
  .superRefine((value, context) => {
    const sourceUrl = value.sourceUrl ?? value.spotifyUrl;
    if (!sourceUrl) {
      context.addIssue({
        code: "custom",
        path: ["sourceUrl"],
        message: "Plak een publieke Spotify-, YouTube- of Google Drive-link.",
      });
      return;
    }
    try {
      validateSourceUrl(sourceUrl);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["sourceUrl"],
        message: error instanceof Error ? error.message : "Ongeldige bronlink",
      });
    }
  })
  .transform(({ sourceUrl, spotifyUrl, language, articleLength }) => ({
    sourceUrl: sourceUrl ?? spotifyUrl!,
    language,
    articleLength,
  }));

const readingStateSchema = z.object({ read: z.boolean() });
const readingPositionSchema = z.object({
  sectionIndex: z.number().int().nonnegative(),
});

app.get("/api/articles", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json(listReadyArticles(response.locals.username));
});

app.get("/api/jobs", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json(
    listProcessingJobs(response.locals.username).map((job) =>
      localizeProcessingJob(job, responseLanguage(response)),
    ),
  );
});

app.patch("/api/articles/:id", async (request, response) => {
  const parsed = readingStateSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      error: localizeError(response, "error.readStateInvalid"),
    });
  }
  try {
    return response.json(
      await setArticleRead(
        response.locals.username,
        request.params.id,
        parsed.data.read,
      ),
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Leesstatus kon niet worden opgeslagen.";
    return response
      .status(message === "Opdracht niet gevonden." ? 404 : 409)
      .json({ error: localizeError(response, message) });
  }
});

app.delete("/api/articles/:id", async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  try {
    await deleteArticle(response.locals.username, request.params.id);
    return response.status(204).end();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Opdracht niet gevonden.") {
      return response
        .status(404)
        .json({ error: localizeError(response, message) });
    }
    if (message === "Dit artikel is nog niet klaar om te verwijderen.") {
      return response
        .status(409)
        .json({ error: localizeError(response, message) });
    }
    return response.status(503).json({
      error: localizeError(response, "error.articleDeleteRetry"),
    });
  }
});

app.patch("/api/jobs/:id/reading-position", async (request, response) => {
  const parsed = readingPositionSchema.safeParse(request.body);
  if (!parsed.success) {
    return response
      .status(400)
      .json({ error: localizeError(response, "error.readingPositionInvalid") });
  }
  try {
    return response.json({
      readingPosition: await setArticleReadingPosition(
        response.locals.username,
        request.params.id,
        parsed.data.sectionIndex,
      ),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Leespositie kon niet worden opgeslagen.";
    return response
      .status(message === "Opdracht niet gevonden." ? 404 : 409)
      .json({
        error: localizeError(response, message, "error.readingPositionSave"),
      });
  }
});

app.post("/api/jobs/:id/share", async (request, response) => {
  try {
    const token = await createArticleShare(
      response.locals.username,
      request.params.id,
    );
    return response
      .status(201)
      .json({ url: `${publicOrigin(request)}/s/${token}` });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Permalink kon niet worden aangemaakt.";
    return response
      .status(message === "Opdracht niet gevonden." ? 404 : 409)
      .json({ error: localizeError(response, message) });
  }
});

app.post("/api/jobs", async (request, response) => {
  const parsed = requestSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      error: localizeError(
        response,
        parsed.error.issues[0]?.message,
        "error.input",
      ),
    });
  }
  if (!process.env.OPENAI_API_KEY) {
    return response.status(503).json({
      error: localizeError(response, "error.creationUnavailable"),
    });
  }
  try {
    const job = await createJob(response.locals.username, parsed.data);
    return response
      .status(202)
      .json(localizeJob(job, responseLanguage(response)));
  } catch (error) {
    if (error instanceof DuplicateJobError) {
      return response.status(409).json({
        error: localizeError(
          response,
          error.existingJob.stage === "complete"
            ? "error.duplicateComplete"
            : "error.duplicateProcessing",
        ),
        existingJobId: error.existingJob.id,
        existingStage: error.existingJob.stage,
      });
    }
    throw error;
  }
});

app.get("/api/jobs/:id", async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  const job = await getJob(response.locals.username, request.params.id);
  return job
    ? response.json(localizeJob(job, responseLanguage(response)))
    : response
        .status(404)
        .json({ error: localizeError(response, "error.jobNotFound") });
});

app.get("/api/jobs/:id/audio", async (request, response) => {
  const job = await getJob(response.locals.username, request.params.id);
  const file = playbackFileForJob(response.locals.username, request.params.id);
  if (!job || !file) {
    return response
      .status(404)
      .json({ error: localizeError(response, "error.audioNotFound") });
  }
  try {
    await stat(file);
    response.setHeader("Cache-Control", "private, max-age=3600");
    return response.sendFile(file);
  } catch {
    return response.status(404).json({
      error: localizeError(response, "error.audioNotReady"),
    });
  }
});

app.get("/api/jobs/:id/pdf", async (request, response) => {
  const job = await getJob(response.locals.username, request.params.id);
  if (!job) {
    return response
      .status(404)
      .json({ error: localizeError(response, "error.jobNotFound") });
  }
  if (job.stage !== "complete" || !job.article || !job.episode) {
    return response.status(409).json({
      error: localizeError(response, "error.pdfNotReady"),
    });
  }
  try {
    const pdf = await generateArticlePdf(
      job,
      `${request.protocol}://${request.get("host")}`,
      responseLanguage(response),
    );
    response.attachment(
      pdfDownloadName(job.article.title, responseLanguage(response)),
    );
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Length", pdf.byteLength);
    return response.send(Buffer.from(pdf));
  } catch (error) {
    console.error(
      `${new Date().toISOString()} ERROR PDF-export mislukt · job=${JSON.stringify(job.id)}`,
      error,
    );
    return response.status(503).json({
      error: localizeError(response, "error.pdfUnavailable"),
    });
  }
});

app.post("/api/jobs/:id/retry-article", async (request, response) => {
  try {
    const job = await retryArticle(response.locals.username, request.params.id);
    return response
      .status(202)
      .json(localizeJob(job, responseLanguage(response)));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Artikelretry kon niet starten.";
    return response
      .status(message === "Opdracht niet gevonden." ? 404 : 409)
      .json({ error: localizeError(response, message) });
  }
});

app.use(sendIndex);

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    next: express.NextFunction,
  ) => {
    if (response.headersSent) {
      return next(error);
    }
    const invalidBody =
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      (error.type === "entity.parse.failed" ||
        error.type === "entity.too.large");
    if (!invalidBody) {
      console.error("Request failed", error);
    }
    return response.status(invalidBody ? 400 : 503).json({
      error: translate(
        responseLanguage(response),
        invalidBody ? "error.input" : "error.generic",
      ),
    });
  },
);

await resumeIncompleteJobs(auth.enabled ? auth.usernames : ["local"]);

const server = app.listen(port, host, () => {
  console.log(
    `${new Date().toISOString()} INFO  Podcast2Article luistert op http://${host}:${port}`,
  );
  console.log(
    `${new Date().toISOString()} INFO  Modellen · transcriptie=${process.env.TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe-diarize"} artikel=${process.env.ARTICLE_MODEL ?? "gpt-5.6-terra"}`,
  );
  if (!process.env.OPENAI_API_KEY) {
    console.warn(
      "OPENAI_API_KEY ontbreekt; nieuwe opdrachten zijn uitgeschakeld.",
    );
  }
  if (!auth.enabled) {
    console.warn(
      "APP_USERS en APP_PASSWORD ontbreken; de applicatie is zonder login bereikbaar.",
    );
  }
});

let shuttingDown = false;
async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(
    `${new Date().toISOString()} INFO  ${signal} ontvangen · graceful shutdown gestart`,
  );
  server.close();
  server.closeIdleConnections();
  const forcedExit = setTimeout(() => {
    console.error(
      `${new Date().toISOString()} ERROR Graceful shutdown duurde langer dan 15 seconden; proces wordt gestopt`,
    );
    process.exit(1);
  }, 15_000);
  forcedExit.unref();
  await shutdownJobs(signal);
  clearTimeout(forcedExit);
  console.log(`${new Date().toISOString()} INFO  Graceful shutdown voltooid`);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
