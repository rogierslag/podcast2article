#!/usr/bin/env node
import { createHmac, timingSafeEqual } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const expectedRepository = "rogierslag/podcast2article";
const expectedRef = "refs/heads/main";
const maximumBodyBytes = 1024 * 1024;

function header(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function signaturesMatch(received, expected) {
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function evaluateGithubWebhook(headers, body, secret) {
  const expectedSignature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  if (!signaturesMatch(header(headers, "x-hub-signature-256"), expectedSignature)) {
    return { status: 401, trigger: false, message: "Invalid signature" };
  }

  const event = header(headers, "x-github-event");
  if (event !== "push") {
    return { status: 202, trigger: false, message: `Ignored ${event || "unknown"} event` };
  }

  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400, trigger: false, message: "Invalid JSON" };
  }

  if (payload?.repository?.full_name !== expectedRepository || payload?.ref !== expectedRef) {
    return { status: 202, trigger: false, message: "Ignored repository or branch" };
  }

  const delivery = header(headers, "x-github-delivery").slice(0, 100);
  if (!delivery) return { status: 400, trigger: false, message: "Missing delivery ID" };
  return { status: 202, trigger: true, message: "Update queued", delivery };
}

export function startWebhookServer(options = {}) {
  const host = options.host ?? process.env.WEBHOOK_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.WEBHOOK_PORT ?? 9000);
  const secret = options.secret ?? process.env.GITHUB_WEBHOOK_SECRET;
  const triggerFile = options.triggerFile ?? process.env.WEBHOOK_TRIGGER_FILE ?? "/run/podcast2article-webhook/trigger";
  if (!secret || secret.length < 32) throw new Error("GITHUB_WEBHOOK_SECRET must contain at least 32 characters.");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("WEBHOOK_PORT is invalid.");

  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/hooks/github") {
      response.writeHead(404, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: "Not found" }));
    }

    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBodyBytes) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on("end", async () => {
      if (tooLarge) {
        response.writeHead(413, { "content-type": "application/json" });
        return response.end(JSON.stringify({ error: "Payload too large" }));
      }
      const result = evaluateGithubWebhook(request.headers, Buffer.concat(chunks), secret);
      if (result.trigger) {
        try {
          await writeFile(triggerFile, `${result.delivery}\n`, { mode: 0o600 });
          console.log(`${new Date().toISOString()} webhook accepted delivery=${JSON.stringify(result.delivery)}`);
        } catch (error) {
          console.error(`${new Date().toISOString()} could not queue webhook update`, error);
          response.writeHead(500, { "content-type": "application/json" });
          return response.end(JSON.stringify({ error: "Could not queue update" }));
        }
      }
      response.writeHead(result.status, { "content-type": "application/json" });
      return response.end(JSON.stringify({ message: result.message }));
    });
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.listen(port, host, () => console.log(`${new Date().toISOString()} GitHub webhook receiver listening on http://${host}:${port}`));
  return server;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const server = startWebhookServer();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}
