import type { Job } from "../types.js";

type DiagnosticData = Record<string, string | number>;

/** Diagnostic text and fields are logged, while type and required parameters drive progress. */
export type ProcessingEvent =
  | {
      type: "transcription.waiting";
      message: string;
      data: DiagnosticData & { chunk: string; waitingSeconds: number };
    }
  | {
      type: "article.waiting";
      message: string;
      data: DiagnosticData & { waitingSeconds: number };
    }
  | {
      type:
        | "transcription.started"
        | "transcription.completed"
        | "article.started"
        | "article.completed";
      message: string;
      data: DiagnosticData;
    };

export function processingProgress(
  event: ProcessingEvent,
): Pick<Job, "message" | "messageValues"> | undefined {
  if (event.type === "transcription.waiting") {
    return {
      message: "progress.wait",
      messageValues: {
        chunk: event.data.chunk,
        minutes: Math.max(1, Math.round(event.data.waitingSeconds / 60)),
      },
    };
  }
  if (event.type === "article.waiting") {
    return {
      message: "progress.writing",
      messageValues: {
        minutes: Math.max(1, Math.round(event.data.waitingSeconds / 60)),
      },
    };
  }
  return undefined;
}
