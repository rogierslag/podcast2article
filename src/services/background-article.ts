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
const defaultQueueTimeoutMs = 60 * 60_000;

function queueTimeoutMs(): number {
  const configured = Number(process.env.OPENAI_ARTICLE_QUEUE_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : defaultQueueTimeoutMs;
}

function retryableResponseRequest(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) {
    return true;
  }
  if (!(error instanceof OpenAI.APIError)) {
    return false;
  }
  const code: unknown = error.code;
  const status: unknown = error.status;
  return retryableHttpRequest({
    httpStatus: typeof status === "number" ? status : undefined,
    errorCode: typeof code === "string" ? code : undefined,
  });
}

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
  const requestOptions = { signal, timeout: 30_000, maxRetries: 0 };
  const queueTimeout = queueTimeoutMs();
  let cancellationError: unknown;
  while (state.status === "queued" || state.status === "in_progress") {
    signal?.throwIfAborted();
    let response: OpenAI.Responses.Response;
    try {
      // Fetch immediately after restart; subsequent requests wait or are woken by a webhook.
      response = await openai.responses.retrieve(
        state.responseId,
        {},
        requestOptions,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (!retryableResponseRequest(error)) {
        throw error;
      }
      await waitForResponse(state.responseId, signal);
      continue;
    }
    if (response.id !== state.responseId) {
      throw new Error("OpenAI returned a different article response ID");
    }
    const createdAt =
      response.created_at > 0
        ? response.created_at * 1000
        : Date.parse(state.request.startedAt);
    if (
      response.status === "queued" &&
      (state.queueCancellationRequested ||
        Date.now() - createdAt >= queueTimeout)
    ) {
      if (
        cancellationError !== undefined &&
        !retryableResponseRequest(cancellationError)
      ) {
        throw cancellationError;
      }
      if (!state.queueCancellationRequested) {
        state = { ...state, queueCancellationRequested: true };
        await checkpoint?.save(state);
      }
      try {
        response = await openai.responses.cancel(
          state.responseId,
          requestOptions,
        );
      } catch (error) {
        signal?.throwIfAborted();
        // A lost reply or state transition can race cancellation. Retrieve before deciding what to do.
        cancellationError = error;
        await waitForResponse(state.responseId, signal);
        continue;
      }
      if (response.id !== state.responseId) {
        throw new Error("OpenAI returned a different cancelled response ID");
      }
      if (response.status === "completed") {
        // Retrieve the completed answer through the SDK path that populates output_text.
        continue;
      }
    }
    const queueTimeoutCancelled =
      response.status === "cancelled" && state.queueCancellationRequested;
    const request = structuredClone(state.request);
    request.responseStatus = response.status;
    if (response.status !== "queued" && response.status !== "in_progress") {
      request.status = response.status === "completed" ? "succeeded" : "failed";
      request.finishedAt = new Date().toISOString();
      request.elapsedMs = Date.now() - Date.parse(request.startedAt);
      request.actualModel = response.model;
      request.actualServiceTier = response.service_tier ?? undefined;
      request.errorCode = queueTimeoutCancelled
        ? "background_queue_timeout"
        : response.error?.code;
      request.errorMessage = queueTimeoutCancelled
        ? "OpenAI response cancelled after exceeding the article queue timeout"
        : response.error?.message;
      request.usage = usageMetrics(response.usage);
      request.cost = estimateApiCost(request);
    }
    state = {
      ...articleSnapshot(response, request, openai.baseURL),
      queueCancellationRequested: state.queueCancellationRequested,
    };
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
      : state.status === "cancelled" && state.queueCancellationRequested
        ? ": article queue timeout"
        : state.incompleteReason
          ? `: ${state.incompleteReason}`
          : "";
    super(`Background article ended with status ${state.status}${detail}`);
  }

  get retryable(): boolean {
    return (
      (this.state.status === "cancelled" &&
        this.state.queueCancellationRequested === true) ||
      (this.state.status === "failed" &&
        [
          "server_error",
          "server_is_overloaded",
          "rate_limit_exceeded",
          "slow_down",
          "flex_unavailable",
        ].includes(this.state.error?.code ?? ""))
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

/** Replace saved responses only after a retryable terminal outcome. */
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
      if (
        !(error instanceof BackgroundArticleError) ||
        !error.retryable ||
        error.state.request.attempt >= requestAttemptLimit(serviceTier)
      ) {
        throw error;
      }
      signal?.throwIfAborted();
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
