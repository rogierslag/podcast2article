import express from "express";
import path from "node:path";
import { z } from "zod";
import { createJob, getJob, resumeIncompleteJobs, retryArticle, shutdownJobs } from "./services/jobs.js";
import { validateSpotifyUrl } from "./services/resolver.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const publicDirectory = path.resolve("public");

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(publicDirectory, { extensions: ["html"] }));

const requestSchema = z.object({
  spotifyUrl: z.string().url().max(500).refine((value) => { try { validateSpotifyUrl(value); return true; } catch { return false; } }, "Ongeldige Spotify-afleveringslink"),
  language: z.enum(["auto", "nl", "en", "de", "fr", "es"]).default("auto"),
  articleLength: z.enum(["compact", "standard", "long"]).default("standard"),
});

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, openaiConfigured: Boolean(process.env.OPENAI_API_KEY) });
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

const server = app.listen(port, () => {
  console.log(`${new Date().toISOString()} INFO  Podcast2Article luistert op http://localhost:${port}`);
  console.log(`${new Date().toISOString()} INFO  Modellen · transcriptie=${process.env.TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe-diarize"} artikel=${process.env.ARTICLE_MODEL ?? "gpt-5.6-terra"}`);
  if (!process.env.OPENAI_API_KEY) console.warn("OPENAI_API_KEY ontbreekt; nieuwe opdrachten zijn uitgeschakeld.");
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
