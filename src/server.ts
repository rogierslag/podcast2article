import express from "express";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createUserAuth, expiredSessionCookie, readCookie, SESSION_COOKIE_NAME, sessionCookie } from "./services/auth.js";
import { createArticleShare, createJob, getJob, getSharedArticle, listProcessingJobs, listReadyArticles, playbackFileForJob, resumeIncompleteJobs, retryArticle, setArticleRead, shutdownJobs } from "./services/jobs.js";
import { generateArticlePdf, pdfDownloadName } from "./services/pdf.js";
import { validateSourceUrl } from "./services/resolver.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST?.trim() || "127.0.0.1";
const publicDirectory = path.resolve("public");
const auth = createUserAuth();
const loginAttempts = new Map<string, { failures: number; blockedUntil: number }>();
const maximumLoginFailures = 5;
const loginBlockMs = 15 * 60 * 1_000;

app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "2kb" }));

function authenticatedUser(cookieHeader: string | undefined): string | undefined {
  return auth.enabled ? auth.sessionUser(readCookie(cookieHeader, SESSION_COOKIE_NAME)) : "local";
}

function publicOrigin(request: express.Request): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  return configured || `${request.protocol}://${request.get("host")}`;
}

function htmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/s/:token", async (request, response) => {
  const shared = getSharedArticle(request.params.token);
  if (!shared) {
    response.type("html");
    return response.status(404).send(await readFile(path.join(publicDirectory, "share-not-found.html"), "utf8"));
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
    `<meta property="og:locale" content="nl_NL">`,
    `<meta property="og:site_name" content="Podcast2Article">`,
    `<meta property="og:title" content="${htmlAttribute(title)}">`,
    `<meta property="og:description" content="${htmlAttribute(description)}">`,
    `<meta property="og:url" content="${htmlAttribute(url)}">`,
    `<meta property="article:published_time" content="${htmlAttribute(job.completedAt ?? job.updatedAt)}">`,
    ...(image ? [
      `<meta property="og:image" content="${htmlAttribute(image)}">`,
      `<meta property="og:image:alt" content="${htmlAttribute(job.episode!.title)}">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:image" content="${htmlAttribute(image)}">`,
      `<meta name="twitter:image:alt" content="${htmlAttribute(job.episode!.title)}">`,
    ] : [`<meta name="twitter:card" content="summary">`]),
    `<meta name="twitter:title" content="${htmlAttribute(title)}">`,
    `<meta name="twitter:description" content="${htmlAttribute(description)}">`,
  ].join("\n  ");
  const template = await readFile(path.join(publicDirectory, "share.html"), "utf8");
  response.setHeader("Cache-Control", "public, max-age=300");
  response.type("html");
  return response.send(template.replace("<!-- SHARE_METADATA -->", metadata));
});

app.get("/api/shared/:token", (request, response) => {
  const shared = getSharedArticle(request.params.token);
  if (!shared) return response.status(404).json({ error: "Gedeeld artikel niet gevonden." });
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
  if (!shared) return response.status(404).json({ error: "Audio niet gevonden." });
  const file = playbackFileForJob(shared.username, shared.job.id);
  if (!file) return response.status(404).json({ error: "Audio niet gevonden." });
  try {
    await stat(file);
    response.setHeader("Cache-Control", "public, max-age=3600");
    return response.sendFile(file);
  } catch {
    return response.status(404).json({ error: "Audio niet gevonden." });
  }
});

app.get(["/share.js", "/share.css", "/styles.css", "/favicon.svg", "/favicon-32.png", "/apple-touch-icon.png"], async (request, response) => {
  const contentTypes: Record<string, string> = {
    ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  };
  response.type(contentTypes[path.extname(request.path)] ?? "application/octet-stream");
  return response.send(await readFile(path.join(publicDirectory, request.path)));
});

app.get("/login", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (authenticatedUser(request.headers.cookie)) return response.redirect(303, "/");
  return response.sendFile(path.join(publicDirectory, "login.html"));
});

app.post("/login", (request, response) => {
  if (!auth.enabled) return response.redirect(303, "/");
  const key = request.ip ?? request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const storedAttempt = loginAttempts.get(key);
  const attempt = storedAttempt && (storedAttempt.blockedUntil === 0 || storedAttempt.blockedUntil > now)
    ? storedAttempt
    : undefined;
  if (storedAttempt && !attempt) loginAttempts.delete(key);
  if (attempt && attempt.blockedUntil > Date.now()) {
    response.setHeader("Retry-After", String(Math.ceil((attempt.blockedUntil - Date.now()) / 1_000)));
    return response.status(429).send("Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.");
  }
  const username = typeof request.body?.username === "string" ? request.body.username.trim().toLowerCase() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const token = auth.authenticate(username, password);
  if (!token) {
    const failures = (attempt?.failures ?? 0) + 1;
    loginAttempts.set(key, {
      failures,
      blockedUntil: failures >= maximumLoginFailures ? Date.now() + loginBlockMs : 0,
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
  if (request.path.startsWith("/api/")) return response.status(401).json({ error: "Log opnieuw in om verder te gaan." });
  return request.method === "GET"
    ? response.redirect(303, "/login")
    : response.status(401).send("Log opnieuw in om verder te gaan.");
});

app.post("/logout", (request, response) => {
  response.setHeader("Set-Cookie", expiredSessionCookie(request.secure));
  return response.redirect(303, "/login");
});

app.get("/api/auth", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ enabled: auth.enabled, username: response.locals.username });
});

app.use(express.static(publicDirectory, { extensions: ["html"] }));

const requestSchema = z.object({
  sourceUrl: z.string().url().max(500).optional(),
  /** Accepted for API compatibility with clients from before generic sources. */
  spotifyUrl: z.string().url().max(500).optional(),
  language: z.enum(["auto", "nl", "en", "de", "fr", "es"]).default("auto"),
  articleLength: z.enum(["compact", "standard", "long"]).default("standard"),
}).superRefine((value, context) => {
  const sourceUrl = value.sourceUrl ?? value.spotifyUrl;
  if (!sourceUrl) {
    context.addIssue({ code: "custom", path: ["sourceUrl"], message: "Plak een publieke Spotify-, YouTube- of Google Drive-link." });
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
}).transform(({ sourceUrl, spotifyUrl, language, articleLength }) => ({
  sourceUrl: sourceUrl ?? spotifyUrl!,
  language,
  articleLength,
}));

const readingStateSchema = z.object({ read: z.boolean() });

app.get("/api/articles", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json(listReadyArticles(response.locals.username));
});

app.get("/api/jobs", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json(listProcessingJobs(response.locals.username));
});

app.patch("/api/articles/:id", async (request, response) => {
  const parsed = readingStateSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Geef een geldige leesstatus op." });
  try {
    return response.json(await setArticleRead(response.locals.username, request.params.id, parsed.data.read));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Leesstatus kon niet worden opgeslagen.";
    return response.status(message === "Opdracht niet gevonden." ? 404 : 409).json({ error: message });
  }
});

app.post("/api/jobs/:id/share", async (request, response) => {
  try {
    const token = await createArticleShare(response.locals.username, request.params.id);
    return response.status(201).json({ url: `${publicOrigin(request)}/s/${token}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Permalink kon niet worden aangemaakt.";
    return response.status(message === "Opdracht niet gevonden." ? 404 : 409).json({ error: message });
  }
});

app.post("/api/jobs", async (request, response) => {
  const parsed = requestSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Ongeldige invoer" });
  if (!process.env.OPENAI_API_KEY) return response.status(503).json({ error: "OPENAI_API_KEY ontbreekt in de CLI-omgeving." });
  const job = await createJob(response.locals.username, parsed.data);
  return response.status(202).json(job);
});

app.get("/api/jobs/:id", async (request, response) => {
  const job = await getJob(response.locals.username, request.params.id);
  return job ? response.json(job) : response.status(404).json({ error: "Opdracht niet gevonden" });
});

app.get("/api/jobs/:id/audio", async (request, response) => {
  const job = await getJob(response.locals.username, request.params.id);
  const file = playbackFileForJob(response.locals.username, request.params.id);
  if (!job || !file) return response.status(404).json({ error: "Audio niet gevonden" });
  try {
    await stat(file);
    response.setHeader("Cache-Control", "private, max-age=3600");
    return response.sendFile(file);
  } catch {
    return response.status(404).json({ error: "Audio is nog niet beschikbaar" });
  }
});

app.get("/api/jobs/:id/pdf", async (request, response) => {
  const job = await getJob(response.locals.username, request.params.id);
  if (!job) return response.status(404).json({ error: "Opdracht niet gevonden" });
  if (job.stage !== "complete" || !job.article || !job.episode) {
    return response.status(409).json({ error: "Dit artikel is nog niet klaar voor PDF-export." });
  }
  try {
    const pdf = await generateArticlePdf(job, `${request.protocol}://${request.get("host")}`);
    response.attachment(pdfDownloadName(job.article.title));
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Length", pdf.byteLength);
    return response.send(Buffer.from(pdf));
  } catch (error) {
    console.error(`${new Date().toISOString()} ERROR PDF-export mislukt · job=${JSON.stringify(job.id)}`, error);
    return response.status(503).json({ error: "PDF-export is op dit moment niet beschikbaar." });
  }
});

app.post("/api/jobs/:id/retry-article", async (request, response) => {
  try {
    const job = await retryArticle(response.locals.username, request.params.id);
    return response.status(202).json(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Artikelretry kon niet starten.";
    return response.status(message === "Opdracht niet gevonden." ? 404 : 409).json({ error: message });
  }
});

app.use((_request, response) => response.sendFile(path.join(publicDirectory, "index.html")));

await resumeIncompleteJobs(auth.enabled ? auth.usernames : ["local"]);

const server = app.listen(port, host, () => {
  console.log(`${new Date().toISOString()} INFO  Podcast2Article luistert op http://${host}:${port}`);
  console.log(`${new Date().toISOString()} INFO  Modellen · transcriptie=${process.env.TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe-diarize"} artikel=${process.env.ARTICLE_MODEL ?? "gpt-5.6-terra"}`);
  if (!process.env.OPENAI_API_KEY) console.warn("OPENAI_API_KEY ontbreekt; nieuwe opdrachten zijn uitgeschakeld.");
  if (!auth.enabled) console.warn("APP_USERS en APP_PASSWORD ontbreken; de applicatie is zonder login bereikbaar.");
});

let shuttingDown = false;
async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${new Date().toISOString()} INFO  ${signal} ontvangen · graceful shutdown gestart`);
  server.close();
  server.closeIdleConnections();
  const forcedExit = setTimeout(() => {
    console.error(`${new Date().toISOString()} ERROR Graceful shutdown duurde langer dan 15 seconden; proces wordt gestopt`);
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
