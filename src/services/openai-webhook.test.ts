import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { openaiWebhookRouter } from "./openai-webhook.js";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop();
  }
  vi.unstubAllEnvs();
});

it("verifies raw-body signatures without a user session and tolerates repeated notifications", async () => {
  const secret = Buffer.from("test-only-webhook-secret");
  vi.stubEnv("OPENAI_API_KEY", "test-only-unused-key");
  vi.stubEnv("OPENAI_WEBHOOK_SECRET", `whsec_${secret.toString("base64")}`);
  const app = express();
  app.use(openaiWebhookRouter());
  app.use((_request, response) => {
    response.sendStatus(401);
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  stops.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const body = JSON.stringify({
    id: "evt-test",
    object: "event",
    type: "response.completed",
    data: { id: "resp-test" },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`wh-test.${timestamp}.${body}`)
    .digest("base64");
  const headers = {
    "content-type": "application/json",
    "webhook-id": "wh-test",
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    expect(
      (await fetch(`${origin}/hooks/openai`, { method: "POST", body, headers }))
        .status,
    ).toBe(204);
  }
  expect(
    (
      await fetch(`${origin}/hooks/openai`, {
        method: "POST",
        body: body.replace("resp-test", "resp-other"),
        headers,
      })
    ).status,
  ).toBe(400);
  expect((await fetch(`${origin}/api/jobs`)).status).toBe(401);
  vi.stubEnv("OPENAI_WEBHOOK_SECRET", "");
  expect(
    (await fetch(`${origin}/hooks/openai`, { method: "POST", body, headers }))
      .status,
  ).toBe(404);
});
