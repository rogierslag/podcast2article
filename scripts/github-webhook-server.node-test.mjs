import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateGithubWebhook } from "./github-webhook-server.mjs";

const secret = "a-secure-webhook-secret-that-is-long-enough";
const body = Buffer.from(
  JSON.stringify({
    ref: "refs/heads/main",
    repository: { full_name: "rogierslag/podcast2article" },
  }),
);

function headers(event = "push", payload = body) {
  return {
    "x-github-delivery": "11111111-1111-1111-1111-111111111111",
    "x-github-event": event,
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
  };
}

test("accepts a signed push to main", () => {
  assert.deepEqual(evaluateGithubWebhook(headers(), body, secret), {
    status: 202,
    trigger: true,
    message: "Update queued",
    delivery: "11111111-1111-1111-1111-111111111111",
  });
});

test("rejects an invalid signature", () => {
  assert.equal(
    evaluateGithubWebhook(
      { ...headers(), "x-hub-signature-256": "sha256=invalid" },
      body,
      secret,
    ).status,
    401,
  );
});

test("authenticates but ignores ping events", () => {
  assert.deepEqual(evaluateGithubWebhook(headers("ping"), body, secret), {
    status: 202,
    trigger: false,
    message: "Ignored ping event",
  });
});

test("ignores another repository or branch", () => {
  const otherBody = Buffer.from(
    JSON.stringify({
      ref: "refs/heads/feature",
      repository: { full_name: "rogierslag/podcast2article" },
    }),
  );
  assert.equal(
    evaluateGithubWebhook(headers("push", otherBody), otherBody, secret)
      .trigger,
    false,
  );
});

test("rejects malformed signed JSON", () => {
  const invalidBody = Buffer.from("{");
  assert.equal(
    evaluateGithubWebhook(headers("push", invalidBody), invalidBody, secret)
      .status,
    400,
  );
});
