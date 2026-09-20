import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";
import {
  estimateApiCost,
  usageMetrics,
  type UsageRecorder,
} from "./api-usage.js";
import type { ApiRequestUsage, BackgroundArticle } from "../types.js";

export interface ArticleCheckpoint {
  state?: BackgroundArticle;
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
          (error.status === 429 || (error.status ?? 0) >= 500)
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
    throw new Error(`Background article ended with status ${state.status}`);
  }
  return state.answer ?? "";
}
