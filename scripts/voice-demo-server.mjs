import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

// A tunnel to this server exposes only demo assets, never application data or APIs.
const assets = new Map([
  ["/", ["voice-demo.html", "text/html; charset=utf-8"]],
  ["/voice-demo.html", ["voice-demo.html", "text/html; charset=utf-8"]],
  ["/voice-demo.js", ["voice-demo.js", "text/javascript; charset=utf-8"]],
  ["/voice-demo.css", ["voice-demo.css", "text/css; charset=utf-8"]],
  ["/theme.css", ["theme.css", "text/css; charset=utf-8"]],
]);
const server = createServer(async (request, response) => {
  const asset = assets.get(
    new URL(request.url || "/", "http://localhost").pathname,
  );
  if (!asset || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const body = await readFile(
      new URL(`../public/${asset[0]}`, import.meta.url),
    );
    response.writeHead(200, {
      "Content-Type": asset[1],
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(500).end("Could not load demo asset");
  }
});
server.listen(4317, "127.0.0.1", () => {
  console.log("Voice demo: http://127.0.0.1:4317");
});
