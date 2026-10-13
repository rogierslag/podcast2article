import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";
import {
  estimateApiCost,
  endpointRegion,
  reserveApiCost,
  trackedRequest,
  retryDelay,
  requestAttemptLimit,
  retryableHttpRequest,
  usageMetrics,
  type UsageRecorder,
} from "./api-usage.js";
import { paidRequestDrain } from "./deployment-drain.js";
import type { ApiRequestUsage, BackgroundArticle } from "../types.js";

export interface ArticleCheckpoint {
  state?: BackgroundArticle;
  requests?: readonly ApiRequestUsage[];
  repairs?: BackgroundArticle[];
  saveRepair?(index: number, state: BackgroundArticle): Promise<void>;
  save(state: BackgroundArticle): Promise<void>;
}

export function articleSnapshot(
  response: OpenAI.Responses.Response,
  request: ApiRequestUsage,
  baseURL: string,
): BackgroundArticle {
  return {
    responseId: response.id,
    baseURL,
    status: response.status ?? "incomplete",
    error: response.error
      ? { code: response.error.code, message: response.error.message }
      : undefined,
    incompleteReason: response.incomplete_details?.reason,
    answer: response.output_text,
    request: structuredClone(request),
  };
}

const listeners = new Map<string, Set<() => void>>();

/** Webhooks only shorten the wait; startup and periodic retrieval remain authoritative. */
export function notifyArticleResponse(responseId: string): void {
  for (const wake of listeners.get(responseId) ?? []) {
    wake();
  }
}

async function waitForResponse(
  responseId: string,
  signal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const wake = () => controller.abort();
  const waiting = listeners.get(responseId) ?? new Set<() => void>();
  waiting.add(wake);
  listeners.set(responseId, waiting);
  try {
    await delay(5_000, undefined, {
      signal: signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal,
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    waiting.delete(wake);
    if (!waiting.size) {
      listeners.delete(responseId);
    }
  }
}

export async function retrieveArticleAnswer(
  openai: OpenAI,
  initial: BackgroundArticle,
  checkpoint: ArticleCheckpoint | undefined,
  signal?: AbortSignal,
  recordUsage?: UsageRecorder,
): Promise<string> {
  let state = initial;
  if (state.baseURL !== openai.baseURL) {
    throw new Error(
      "The saved article response belongs to a different OpenAI endpoint",
    );
  }
  while (state.status === "queued" || state.status === "in_progress") {
    signal?.throwIfAborted();
    let response: OpenAI.Responses.Response;
    try {
      // Fetch immediately after restart; subsequent requests wait or are woken by a webhook.
      response = await openai.responses.retrieve(
        state.responseId,
        {},
        {
          signal,
          timeout: 30_000,
          maxRetries: 0,
        },
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (
        !(error instanceof OpenAI.APIConnectionError) &&
        !(
          error instanceof OpenAI.APIError &&
          retryableHttpRequest({
            httpStatus:
              typeof error.status === "number" ? error.status : undefined,
            errorCode: typeof error.code === "string" ? error.code : undefined,
          })
        )
      ) {
        throw error;
      }
      await waitForResponse(state.responseId, signal);
      continue;
    }
    const request = structuredClone(state.request);
    request.responseStatus = response.status;
    if (response.status !== "queued" && response.status !== "in_progress") {
      request.status = response.status === "completed" ? "succeeded" : "failed";
      request.finishedAt = new Date().toISOString();
      request.elapsedMs = Date.now() - Date.parse(request.startedAt);
      request.actualModel = response.model;
      request.actualServiceTier = response.service_tier ?? undefined;
      request.errorCode = response.error?.code;
      request.errorMessage = response.error?.message;
      request.usage = usageMetrics(response.usage);
      request.cost = estimateApiCost(request);
    }
    state = articleSnapshot(response, request, openai.baseURL);
    await checkpoint?.save(state);
    if (state.status === "queued" || state.status === "in_progress") {
      await waitForResponse(state.responseId, signal);
    }
  }
  // Reconcile accounting too if a crash happened after the answer was saved.
  await recordUsage?.(state.request);
  if (state.status !== "completed") {
    throw new BackgroundArticleError(state);
  }
  return state.answer ?? "";
}

class BackgroundArticleError extends Error {
  constructor(readonly state: BackgroundArticle) {
    const detail = state.error
      ? `: ${state.error.code}: ${state.error.message}`
      : state.incompleteReason
        ? `: ${state.incompleteReason}`
        : "";
    super(`Background article ended with status ${state.status}${detail}`);
  }

  get retryable(): boolean {
    return (
      this.state.status === "failed" &&
      [
        "server_error",
        "server_is_overloaded",
        "rate_limit_exceeded",
        "slow_down",
        "flex_unavailable",
      ].includes(this.state.error?.code ?? "")
    );
  }
}

interface BackgroundRequestOptions {
  serviceTier: "flex" | "default";
  timeoutMs: number;
  signal?: AbortSignal;
  recordUsage?: UsageRecorder;
  checkpoint?: ArticleCheckpoint;
}

/** Only a confirmed transient terminal failure can replace a saved provider response. */
export async function requestBackgroundArticle(
  openai: OpenAI,
  payload: OpenAI.Responses.ResponseCreateParamsNonStreaming,
  options: BackgroundRequestOptions,
): Promise<string> {
  const { checkpoint, signal, recordUsage, timeoutMs } = options;
  const initial = checkpoint?.state;
  let saved = initial;
  const originalTier =
    initial?.request.initialServiceTier ??
    initial?.request.requestedServiceTier;
  const serviceTier = saved
    ? originalTier === "flex" ||
      (!saved.request.initialServiceTier && saved.request.attempt > 3)
      ? "flex"
      : "default"
    : options.serviceTier;
  const model = saved?.request.requestedModel ?? payload.model;
  if (!model) {
    throw new Error("Article model is missing");
  }
  const requestPayload = { ...payload, model };
  let previousRequest: ApiRequestUsage | undefined;
  const recoveredRequest = initial
    ? checkpoint?.requests?.reduce(
        (latest, request) =>
          request.operationId === initial.request.operationId &&
          request.attempt > latest.attempt
            ? request
            : latest,
        initial.request,
      )
    : undefined;
  const savingCheckpoint: ArticleCheckpoint = {
    save: async (state) => {
      saved = state;
      await checkpoint?.save(state);
    },
  };
  while (true) {
    signal?.throwIfAborted();
    const resumed = Boolean(saved);
    if (!saved) {
      const reservedCostUsd = reserveApiCost(
        model,
        endpointRegion(openai.baseURL),
        {
          inputBytes: Buffer.byteLength(JSON.stringify(requestPayload)),
          outputTokens: payload.max_output_tokens ?? 0,
        },
      );
      await trackedRequest<OpenAI.Responses.Response>(
        {
          stage: "article",
          background: true,
          previousRequest,
          acquire: (requestSignal) => paidRequestDrain.acquire(requestSignal),
          saveResult: (response, request) =>
            savingCheckpoint.save(
              articleSnapshot(response, request, openai.baseURL),
            ),
          serviceTier,
          model,
          region: endpointRegion(openai.baseURL),
          reservedCostUsd,
          signal,
          record: recordUsage,
        },
        (requestedTier) =>
          openai.responses
            .create(
              { ...requestPayload, service_tier: requestedTier },
              { timeout: timeoutMs, signal, maxRetries: 0 },
            )
            .withResponse(),
      );
    }
    if (!saved) {
      throw new Error("Article response was not saved");
    }
    try {
      return await retrieveArticleAnswer(
        openai,
        saved,
        savingCheckpoint,
        signal,
        resumed || saved.status === "queued" || saved.status === "in_progress"
          ? recordUsage
          : undefined,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (
        !(error instanceof BackgroundArticleError) ||
        !error.retryable ||
        error.state.request.attempt >= requestAttemptLimit(serviceTier)
      ) {
        throw error;
      }
      previousRequest =
        recoveredRequest &&
        recoveredRequest.attempt > error.state.request.attempt
          ? recoveredRequest
          : error.state.request;
      if (previousRequest.status !== "failed") {
        throw new Error(
          "The saved article submission has an unknown provider outcome; operator investigation is required",
        );
      }
      if (previousRequest.attempt >= requestAttemptLimit(serviceTier)) {
        throw error;
      }
      if (
        previousRequest.attempt > error.state.request.attempt &&
        !retryableHttpRequest(previousRequest)
      ) {
        throw new Error(
          `The saved article submission failed: ${previousRequest.errorCode ?? previousRequest.httpStatus ?? "unknown error"}`,
        );
      }
      // Backoff and remote polling hold no paid-request drain reservation.
      await delay(retryDelay(error, previousRequest.attempt), undefined, {
        signal,
      });
      saved = undefined;
    }
  }
}
