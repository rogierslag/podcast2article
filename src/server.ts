import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { z } from "zod";
import { DomainError, domainErrorStatus } from "./lib/errors.js";
import {
  ArticleVisits,
  countArticleArrivals,
} from "./services/article-visits.js";
import {
  startArticleBackups,
  stopArticleBackups,
} from "./services/article-backups.js";
import {
  AccountBudgetError,
  spendingLimitExempt,
} from "./services/account-budget.js";
import { deploymentFailed, deploymentHealth } from "./services/deployment.js";
import { resolveGitSha } from "./lib/git.js";
import { socialMetadata, type SocialImage } from "./lib/social-metadata.js";
import {
  translateDomainError,
  localizeJob,
  localizeProcessingJob,
  localizeTemplate,
  requestLanguage,
} from "./lib/i18n.js";
import { translate } from "../public/i18n.js";
import {
  prefillDestination,
  sourcePrefill,
  sharedSourcePrefill,
} from "../public/source-prefill.js";
import {
  createUserAuth,
  expiredSessionCookie,
  readCookie,
  SESSION_COOKIE_NAME,
  sessionCookie,
} from "./services/auth.js";
import {
  getAccountBudget,
  createArticleShare,
  recordSharedArticleEvent,
  createJob,
  createPodcastJob,
  podcastOutstandingCount,
  userDirectory,
  DuplicateJobError,
  deleteArticle,
  getJob,
  getSharedArticle,
  findSavedSharedArticle,
  saveSharedArticle,
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

import { fetchPodcastFeed } from "./services/podcast-feeds.js";
import { SubscriptionStore } from "./services/subscriptions.js";
import { subscriptionRouter } from "./services/subscription-routes.js";

const subscriptions = new SubscriptionStore({
  directory: userDirectory,
  fetchFeed: fetchPodcastFeed,
  enqueue: createPodcastJob,
  outstanding: podcastOutstandingCount,
  canProcess: () => Boolean(process.env.OPENAI_API_KEY),
});
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
// Validate operator configuration before the server accepts work.
spendingLimitExempt(auth.usernames[0] ?? "local");
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
  response.vary("Cookie");
  next();
});
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "2kb" }));

function responseLanguage(response: express.Response) {
  return requestLanguage(
    response.req.get("Accept-Language"),
    response.req.headers.cookie,
  );
}

function localizeError(
  response: express.Response,
  message: unknown,
  fallback = "error.generic",
): string {
  return typeof message === "string"
    ? translate(responseLanguage(response), message, {})
    : translateDomainError(responseLanguage(response), message, fallback);
}

function renderPage(response: express.Response, template: string): string {
  const language = responseLanguage(response);
  response.setHeader("Content-Language", language);
  return localizeTemplate(template, language).replace(
    "<!-- SITE_METADATA -->",
    socialMetadata({
      type: "website",
      title: translate(language, "page.title"),
      description: translate(language, "page.description"),
      // Private routes and incoming source URLs never belong in the product preview.
      url: `${publicOrigin(response.req)}/`,
      image: brandSocialImage(response),
    }),
  );
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

function brandSocialImage(response: express.Response): SocialImage {
  const language = responseLanguage(response);
  return {
    url: `${publicOrigin(response.req)}/social-card-${language}.png`,
    alt: translate(language, "social.imageAlt"),
    width: 1200,
    height: 630,
    type: "image/png",
  };
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
  return `<p class="build-sha" data-build-sha="${gitSha}" title="${translate(language, "build.label", { sha: gitSha })}">${translate(language, "build", { sha: shortSha })}</p>`;
}

app.get("/api/health", async (_request, response) => {
  response.set("Cache-Control", "no-store");
  response.json({ ok: true, deployment: await deploymentHealth(gitSha) });
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
  const sourceImage = job.episode!.imageUrl;
  const metadata = [
    `<title>${htmlAttribute(title)} — Podcast2Article</title>`,
    `<meta name="description" content="${htmlAttribute(description)}">`,
    socialMetadata({
      type: "article",
      title,
      description,
      url,
      publishedAt: job.completedAt ?? job.updatedAt,
      image: sourceImage
        ? { url: sourceImage, alt: job.episode!.title }
        : brandSocialImage(response),
    }),
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

const shareEventSchema = z
  .object({
    visitId: z.string().uuid(),
    event: z.enum(["load", "read"]),
  })
  .strict();

app.post("/api/shared/:token/events", async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (!getSharedArticle(request.params.token)) {
    return response.sendStatus(404);
  }
  const parsed = shareEventSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.sendStatus(400);
  }
  const accepted = await recordSharedArticleEvent(
    request.params.token,
    parsed.data.visitId,
    parsed.data.event,
  );
  return response.sendStatus(accepted ? 204 : 409);
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
    await stat(file);
    response.setHeader("Cache-Control", "public, max-age=3600");
    return response.sendFile(path.basename(file), { root: path.dirname(file) });
  } catch {
    return response
      .status(404)
      .json({ error: localizeError(response, "error.audioNotFound") });
  }
});

app.get(
  [
    "/share.js",
    "/share-analytics.js",
    "/source-preview.js",
    "/i18n.js",
    "/article-length.js",
    "/localize.js",
    "/share.css",
    "/styles.css",
    "/theme.css",
    "/favicon.svg",
    "/favicon.ico",
    "/app-icon.svg",
    "/social-card-nl.png",
    "/social-card-en.png",
    "/favicon-32.png",
    "/apple-touch-icon.png",
    "/manifest.webmanifest",
    "/icon-192.png",
    "/icon-512.png",
  ],
  async (request, response) => {
    const contentTypes: Record<string, string> = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".ico": "image/vnd.microsoft.icon",
      ".png": "image/png",
      ".webmanifest": "application/manifest+json",
    };
    response.type(
      contentTypes[path.extname(request.path)] ?? "application/octet-stream",
    );
    return response.send(
      await readFile(path.join(publicDirectory, request.path)),
    );
  },
);

// Incoming shares only prepare form data; authentication and submission stay unchanged.
app.get("/share-target", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  return response.redirect(
    303,
    prefillDestination(
      sharedSourcePrefill(
        request.query.url,
        request.query.text,
        request.query.title,
      ),
    ),
  );
});

app.get("/login", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (authenticatedUser(request.headers.cookie)) {
    return response.redirect(303, prefillDestination(request.query.sourceUrl));
  }
  response.type("html");
  return response.send(
    renderPage(response, loginTemplate)
      .replace(
        "<!-- SOURCE_PREFILL -->",
        `<input type="hidden" name="sourceUrl" value="${htmlAttribute(sourcePrefill(request.query.sourceUrl))}">`,
      )
      .replace("<!-- GIT_SHA -->", loginBuildMarkup(response)),
  );
});

app.post("/login", (request, response) => {
  if (!auth.enabled) {
    return response.redirect(303, prefillDestination(request.body?.sourceUrl));
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
    const destination = prefillDestination(request.body?.sourceUrl, "/login");
    return response.redirect(
      303,
      `${destination}${destination.includes("?") ? "&" : "?"}error=1`,
    );
  }
  loginAttempts.delete(key);
  response.setHeader("Set-Cookie", sessionCookie(token, request.secure));
  return response.redirect(303, prefillDestination(request.body?.sourceUrl));
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
    ? response.redirect(
        303,
        prefillDestination(
          request.path === "/" ? request.query.sourceUrl : undefined,
          "/login",
        ),
      )
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

app.get("/api/account-budget", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json(getAccountBudget(response.locals.username));
});

app.get("/api/deployment-status", async (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ failed: auth.enabled && (await deploymentFailed()) });
});

// Account-specific save state stays behind authentication and out of public caches.
app.get("/api/saved-shares/:token", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (!getSharedArticle(request.params.token)) {
    return response
      .status(404)
      .json({ error: localizeError(response, "error.sharedNotFound") });
  }
  const saved = findSavedSharedArticle(
    response.locals.username,
    request.params.token,
  );
  return response.json({ articleId: saved?.id ?? null });
});

app.post("/api/saved-shares/:token", async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (!getSharedArticle(request.params.token)) {
    return response
      .status(404)
      .json({ error: localizeError(response, "error.sharedNotFound") });
  }
  try {
    const saved = await saveSharedArticle(
      response.locals.username,
      request.params.token,
    );
    return response.json({ articleId: saved.id });
  } catch {
    return response
      .status(500)
      .json({ error: localizeError(response, "error.sharedSave") });
  }
});

app.use("/api/subscriptions", subscriptionRouter(subscriptions));
app.get("/series", async (_request, response) => {
  const template = await readFile(
    path.join(publicDirectory, "series.html"),
    "utf8",
  );
  response.type("html").send(renderPage(response, template));
});
app.get(["/", "/index.html", "/articles"], sendIndex);
app.get("/shortcuts/Add%20to%20Reads.shortcut", (_request, response) => {
  response.type("application/x-apple-shortcut");
  return response.download("Add to Reads.shortcut", "Add to Reads.shortcut", {
    root: path.join(publicDirectory, "shortcuts"),
  });
});
app.use((request, response, next) => {
  // HTML files are templates, never serve their untranslated placeholders as static assets.
  if (request.path.endsWith(".html")) {
    return handleUnknownRoute(request, response);
  }
  next();
});
app.use(express.static(publicDirectory, { index: false }));

const requestSchema = z
  .object({
    sourceUrl: z.string().url().max(500),
    language: z.enum(["auto", "nl", "en", "de", "fr", "es"]).default("auto"),
    articleLength: z.enum(["compact", "standard", "long"]).default("standard"),
  })
  .superRefine((value, context) => {
    const sourceUrl = value.sourceUrl;
    try {
      validateSourceUrl(sourceUrl);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["sourceUrl"],
        message:
          error instanceof DomainError ? error.code : "error.sourceLinkInvalid",
      });
    }
  });

const readingStateSchema = z.object({ read: z.boolean() });
const readingPositionSchema = z.object({
  sectionIndex: z.number().int().nonnegative(),
});

const articleVisits = new ArticleVisits(userDirectory);
app.get("/api/articles/arrivals", async (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  const username = response.locals.username;
  const checkpoint = await articleVisits.checkpoint(username);
  const count = countArticleArrivals(
    listReadyArticles(username),
    subscriptions.list(username),
    checkpoint,
  );
  response.json({ count });
});

app.post("/api/articles/visit", async (request, response) => {
  const parsed = z
    .object({ visitedAt: z.iso.datetime() })
    .safeParse(request.body);
  if (!parsed.success || Date.parse(parsed.data.visitedAt) > Date.now()) {
    return response.sendStatus(400);
  }
  await articleVisits.checkpoint(
    response.locals.username,
    new Date(parsed.data.visitedAt).toISOString(),
  );
  response.sendStatus(204);
});

app.get("/api/articles", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Articles-Snapshot", new Date().toISOString());
  response.json(listReadyArticles(response.locals.username));
});

app.get("/api/jobs/:id/share-stats", async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  const job = await getJob(response.locals.username, request.params.id);
  if (!job || job.stage !== "complete") {
    return response.sendStatus(404);
  }
  response.json({
    loads: job.shareAnalytics?.loads ?? 0,
    reads: job.shareAnalytics?.reads ?? 0,
    lastLoadedAt: job.shareAnalytics?.lastLoadedAt,
    lastReadAt: job.shareAnalytics?.lastReadAt,
  });
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
    return response.status(domainErrorStatus(error, 409)).json({
      error: translateDomainError(
        responseLanguage(response),
        error,
        "error.readState",
      ),
    });
  }
});

app.delete("/api/articles/:id", async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  try {
    await deleteArticle(response.locals.username, request.params.id);
    return response.status(204).end();
  } catch (error) {
    return response.status(domainErrorStatus(error, 503)).json({
      error: translateDomainError(
        responseLanguage(response),
        error,
        "error.articleDeleteRetry",
      ),
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
    return response.status(domainErrorStatus(error, 409)).json({
      error: translateDomainError(
        responseLanguage(response),
        error,
        "error.readingPositionSave",
      ),
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
    return response.status(domainErrorStatus(error, 409)).json({
      error: translateDomainError(
        responseLanguage(response),
        error,
        "error.shareCreate",
      ),
    });
  }
});

app.post("/api/jobs", async (request, response) => {
  const parsed = requestSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      error: localizeError(
        response,
        parsed.error.issues.find((issue) => issue.code === "custom")?.message ??
          "error.input",
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
    if (error instanceof AccountBudgetError) {
      return response
        .status(429)
        .json({ error: localizeError(response, error) });
    }
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
    return response.sendFile(path.basename(file), { root: path.dirname(file) });
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
    return response.status(domainErrorStatus(error, 409)).json({
      error: translateDomainError(
        responseLanguage(response),
        error,
        "error.articleRetry",
      ),
    });
  }
});

function handleUnknownRoute(
  request: express.Request,
  response: express.Response,
) {
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    request.path !== "/api" &&
    !request.path.startsWith("/api/") &&
    request.path !== "/s" &&
    !request.path.startsWith("/s/")
  ) {
    return response.redirect(302, "/articles");
  }
  return response.sendStatus(404);
}

app.use(handleUnknownRoute);

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
startArticleBackups();
await subscriptions.load(auth.enabled ? auth.usernames : ["local"]);
subscriptions.start();

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
      "APP_USERS ontbreekt; de applicatie is zonder login bereikbaar.",
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
  await Promise.all([
    subscriptions.stop(),
    shutdownJobs(signal),
    stopArticleBackups(),
  ]);
  clearTimeout(forcedExit);
  console.log(`${new Date().toISOString()} INFO  Graceful shutdown voltooid`);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
