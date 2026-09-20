import { expect, it } from "vitest";
import { processingProgress } from "./processing-events.js";

it.each([
  "Nog in afwachting van OpenAI",
  "Waiting for a response",
  "Changed log wording",
])("updates waiting progress regardless of log text: %s", (message) => {
  expect(
    processingProgress({
      type: "transcription.waiting",
      message,
      data: { chunk: "2/3", waitingSeconds: 121 },
    }),
  ).toEqual({
    message: "progress.wait",
    messageValues: { chunk: "2/3", minutes: 2 },
  });
  expect(
    processingProgress({
      type: "article.waiting",
      message,
      data: { waitingSeconds: 0 },
    }),
  ).toEqual({ message: "progress.writing", messageValues: { minutes: 1 } });
});

it("does not interpret a waiting prefix in an unrelated event as progress", () => {
  expect(
    processingProgress({
      type: "article.completed",
      message: "Nog in afwachting",
      data: { waitingSeconds: 120 },
    }),
  ).toBeUndefined();
});
