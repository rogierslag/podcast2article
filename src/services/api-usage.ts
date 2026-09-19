import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";
import type {
  ApiRequestUsage,
  ApiUsageMetrics,
  ApiCostEstimate,
} from "../types.js";

export type UsageRecorder = (request: ApiRequestUsage) => Promise<void>;
const pricingDate = "2026-09-19";
const pricingSource = "https://developers.openai.com/api/docs/pricing";

// Standard short-context rates per million tokens. Sol's promotional rates
// are published through at least November 21, 2026; recheck before updating.
const articlePricing = new Map([
  [
    "gpt-5.6-terra",
    { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
  ],
  ["gpt-5.6-sol", { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 }],
]);

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** Keep numeric counters only, never response text, prompts, or error bodies. */
export function usageMetrics(value: unknown, depth = 0): ApiUsageMetrics {
  const metrics: ApiUsageMetrics = {};
  for (const [key, entry] of Object.entries(object(value))) {
    if (typeof entry === "number" && Number.isFinite(entry) && entry >= 0) {
      metrics[key] = entry;
    } else if (entry && typeof entry === "object" && depth < 3) {
      metrics[key] = usageMetrics(entry, depth + 1);
    }
  }
  return metrics;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function estimateApiCost(request: ApiRequestUsage): ApiCostEstimate {
  const unknown = (reason: string): ApiCostEstimate => ({
    currency: "USD",
    amount: null,
    reason,
  });
  if (request.status !== "succeeded") {
    return unknown("No confirmed billable usage for this attempt");
  }
  if (request.endpointRegion === "custom") {
    return unknown("Custom endpoint pricing is unknown");
  }
  const model = request.actualModel ?? request.requestedModel;
  const modelPricing = articlePricing.get(model);
  const usage = request.usage ?? {};
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const tier = request.actualServiceTier;
  let amount: number;
  let rates: Record<string, number>;
  let basis: string;
  if (
    model === "gpt-4o-transcribe-diarize" &&
    request.stage === "transcription"
  ) {
    if (request.audioSeconds === undefined) {
      return unknown(
        "Reported audio duration is missing; token counters are retained",
      );
    }
    rates = { perMinute: 0.006 };
    amount = (request.audioSeconds / 60) * 0.006;
    basis = "reported_duration";
  } else if (modelPricing && request.stage === "article") {
    if (input === undefined || output === undefined) {
      return unknown("Token usage is missing");
    }
    if (!tier || !["default", "flex", "priority", "fast"].includes(tier)) {
      return unknown("Actual service tier is unknown or unsupported");
    }
    const details = object(usage.input_tokens_details);
    const cached = count(details.cached_tokens) ?? 0;
    const written = count(details.cache_write_tokens) ?? 0;
    if (cached + written > input) {
      return unknown("Inconsistent input token breakdown");
    }
    const multiplier = tier === "flex" ? 0.5 : tier === "default" ? 1 : 2;
    const longContext = input > 272_000;
    const inputMultiplier = (longContext ? 2 : 1) * multiplier;
    const outputMultiplier = (longContext ? 1.5 : 1) * multiplier;
    const regional = request.endpointRegion === "global" ? 1 : 1.1;
    const tokenRates = {
      inputPerMillion: modelPricing.input * inputMultiplier,
      cachedInputPerMillion: modelPricing.cachedInput * inputMultiplier,
      cacheWritePerMillion: modelPricing.cacheWrite * inputMultiplier,
      outputPerMillion: modelPricing.output * outputMultiplier,
      regionalMultiplier: regional,
    };
    rates = tokenRates;
    // Reasoning tokens are already included in output_tokens.
    amount =
      (((input - cached - written) * tokenRates.inputPerMillion +
        cached * tokenRates.cachedInputPerMillion +
        written * tokenRates.cacheWritePerMillion +
        output * tokenRates.outputPerMillion) /
        1_000_000) *
      regional;
    basis = "reported_tokens";
  } else {
    return unknown("No verified pricing for this model");
  }
  return { currency: "USD", amount, basis, pricingDate, pricingSource, rates };
}

export function endpointRegion(
  baseURL: string,
): ApiRequestUsage["endpointRegion"] {
  const url = new URL(baseURL);
  if (url.protocol !== "https:" || url.pathname.replace(/\/$/, "") !== "/v1") {
    return "custom";
  }
  if (url.hostname === "api.openai.com") {
    return "global";
  }
  if (url.hostname === "eu.api.openai.com") {
    return "eu";
  }
  if (url.hostname === "us.api.openai.com") {
    return "us";
  }
  return "custom";
}

interface TrackedRequest {
  stage: ApiRequestUsage["stage"];
  model: string;
  region: ApiRequestUsage["endpointRegion"];
  chunkNumber?: number;
  signal?: AbortSignal;
  record?: UsageRecorder;
}

function retryDelay(error: unknown, attempt: number): number {
  const header =
    error instanceof OpenAI.APIError ? error.headers?.get("retry-after") : null;
  if (header) {
    const seconds = Number(header);
    const milliseconds = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(header) - Date.now();
    if (milliseconds > 0 && milliseconds <= 60_000) {
      return milliseconds;
    }
  }
  return 500 * 2 ** (attempt - 1);
}

/** SDK retries are disabled at the call site so every HTTP attempt is recorded. */
export async function trackedRequest<T>(
  options: TrackedRequest,
  send: () => Promise<{
    data: T;
    response: Response;
    request_id: string | null;
  }>,
): Promise<T> {
  const operationId = randomUUID();
  for (let attempt = 1; ; attempt += 1) {
    options.signal?.throwIfAborted();
    const started = Date.now();
    const request: ApiRequestUsage = {
      id: randomUUID(),
      operationId,
      attempt,
      stage: options.stage,
      chunkNumber: options.chunkNumber,
      requestedModel: options.model,
      requestedServiceTier: options.stage === "article" ? "auto" : "default",
      endpointRegion: options.region,
      startedAt: new Date(started).toISOString(),
      status: "pending",
      cost: {
        currency: "USD",
        amount: null,
        reason: "Request has no confirmed outcome",
      },
    };
    await options.record?.(request);
    let result;
    let failure: unknown;
    try {
      result = await send();
    } catch (error) {
      failure = error;
    }
    request.finishedAt = new Date().toISOString();
    request.elapsedMs = Date.now() - started;
    if (result) {
      const data = object(result.data);
      request.status = "succeeded";
      request.httpStatus = result.response.status;
      request.requestId = result.request_id ?? undefined;
      request.actualModel =
        typeof data.model === "string" ? data.model : undefined;
      request.actualServiceTier =
        typeof data.service_tier === "string"
          ? data.service_tier
          : options.stage === "transcription"
            ? "default"
            : undefined;
      request.responseStatus =
        typeof data.status === "string" ? data.status : undefined;
      request.usage = usageMetrics(data.usage);
      request.audioSeconds =
        count(object(data.usage).seconds) ?? count(data.duration);
      request.cost = estimateApiCost(request);
      // Persist before callers parse or validate generated content.
      await options.record?.(request);
      return result.data;
    }
    request.status = options.signal?.aborted ? "aborted" : "failed";
    if (failure instanceof OpenAI.APIError) {
      request.httpStatus = failure.status;
      request.requestId = failure.requestID ?? undefined;
      request.errorCode = failure.code ?? undefined;
    }
    request.cost = estimateApiCost(request);
    await options.record?.(request);
    const status = request.httpStatus;
    const retryHeader =
      failure instanceof OpenAI.APIError
        ? failure.headers?.get("x-should-retry")
        : null;
    const retryable =
      retryHeader === "true" ||
      (retryHeader !== "false" &&
        (failure instanceof OpenAI.APIConnectionError ||
          status === 408 ||
          status === 409 ||
          status === 429 ||
          (status !== undefined && status >= 500)));
    if (request.status === "aborted" || attempt >= 3 || !retryable) {
      throw failure;
    }
    await delay(retryDelay(failure, attempt), undefined, {
      signal: options.signal,
    });
  }
}
