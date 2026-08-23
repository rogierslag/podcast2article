import express from "express";
import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createPasswordAuth, expiredSessionCookie, readCookie, SESSION_COOKIE_NAME, sessionCookie } from "./services/auth.js";
import { createJob, getJob, listProcessingJobs, listReadyArticles, playbackFileForJob, resumeIncompleteJobs, retryArticle, setArticleRead, shutdownJobs } from "./services/jobs.js";
import { generateArticlePdf, pdfDownloadName, shutdownPdfBrowser } from "./services/pdf.js";
import { validateSourceUrl } from "./services/resolver.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST?.trim() || "127.0.0.1";
const publicDirectory = path.resolve("public");
const auth = createPasswordAuth();
const loginAttempts = new Map<string, { failures: number; blockedUntil: number }>();
const maximumLoginFailures = 5;
const loginBlockMs = 15 * 60 * 1_000;

app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "2kb" }));

function isAuthenticated(cookieHeader: string | undefined): boolean {
  return !auth.enabled || auth.sessionIsValid(readCookie(cookieHeader, SESSION_COOKIE_NAME));
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/login", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (isAuthenticated(request.headers.cookie)) return response.redirect(303, "/");
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
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  if (!auth.passwordMatches(password)) {
    const failures = (attempt?.failures ?? 0) + 1;
    loginAttempts.set(key, {
      failures,
      blockedUntil: failures >= maximumLoginFailures ? Date.now() + loginBlockMs : 0,
    });
    return response.redirect(303, "/login?error=1");
  }
  loginAttempts.delete(key);
  response.setHeader("Set-Cookie", sessionCookie(auth.createSession()!, request.secure));
  return response.redirect(303, "/");
});

app.use((request, response, next) => {
  if (isAuthenticated(request.headers.cookie)) return next();
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
  response.json({ enabled: auth.enabled });
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
  response.json(listReadyArticles());
});

app.get("/api/jobs", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json(listProcessingJobs());
});

app.patch("/api/articles/:id", async (request, response) => {
  const parsed = readingStateSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Geef een geldige leesstatus op." });
  try {
    return response.json(await setArticleRead(request.params.id, parsed.data.read));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Leesstatus kon niet worden opgeslagen.";
    return response.status(message === "Opdracht niet gevonden." ? 404 : 409).json({ error: message });
  }
});

app.post("/api/jobs", async (request, response) => {
  const parsed = requestSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Ongeldige invoer" });
  if (!process.env.OPENAI_API_KEY) return response.status(503).json({ error: "OPENAI_API_KEY ontbreekt in de CLI-omgeving." });
  const job = await createJob(parsed.data);
  return response.status(202).json(job);
});

app.get("/api/jobs/:id", async (request, response) => {
  const job = await getJob(request.params.id);
  return job ? response.json(job) : response.status(404).json({ error: "Opdracht niet gevonden" });
});

app.get("/api/jobs/:id/audio", async (request, response) => {
  const job = await getJob(request.params.id);
  const file = playbackFileForJob(request.params.id);
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
  const job = await getJob(request.params.id);
  if (!job) return response.status(404).json({ error: "Opdracht niet gevonden" });
  if (job.stage !== "complete" || !job.article || !job.episode) {
    return response.status(409).json({ error: "Dit artikel is nog niet klaar voor PDF-export." });
  }
  try {
    const pdf = await generateArticlePdf(job.id, `http://127.0.0.1:${port}`);
    response.attachment(pdfDownloadName(job.article.title));
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Length", pdf.byteLength);
    return response.send(Buffer.from(pdf));
  } catch (error) {
    console.error(`${new Date().toISOString()} ERROR PDF-export mislukt · job=${JSON.stringify(job.id)}`, error);
    return response.status(503).json({ error: "PDF-export is niet beschikbaar. Controleer de browserconfiguratie van de server." });
  }
});

app.post("/api/jobs/:id/retry-article", async (request, response) => {
  try {
    const job = await retryArticle(request.params.id);
    return response.status(202).json(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Artikelretry kon niet starten.";
    return response.status(message === "Opdracht niet gevonden." ? 404 : 409).json({ error: message });
  }
});

app.use((_request, response) => response.sendFile(path.join(publicDirectory, "index.html")));

await resumeIncompleteJobs();

const server = app.listen(port, host, () => {
  console.log(`${new Date().toISOString()} INFO  Podcast2Article luistert op http://${host}:${port}`);
  console.log(`${new Date().toISOString()} INFO  Modellen · transcriptie=${process.env.TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe-diarize"} artikel=${process.env.ARTICLE_MODEL ?? "gpt-5.6-terra"}`);
  if (!process.env.OPENAI_API_KEY) console.warn("OPENAI_API_KEY ontbreekt; nieuwe opdrachten zijn uitgeschakeld.");
  if (!auth.enabled) console.warn("APP_PASSWORD ontbreekt; de applicatie is zonder login bereikbaar.");
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
  await shutdownPdfBrowser();
  clearTimeout(forcedExit);
  console.log(`${new Date().toISOString()} INFO  Graceful shutdown voltooid`);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
