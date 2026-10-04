import type OpenAI from "openai";

export function articleModel(): string {
  return process.env.ARTICLE_MODEL ?? "gpt-6.1-sol";
}

export function articleReasoning(
  model: string,
): OpenAI.Responses.ResponseCreateParamsNonStreaming["reasoning"] {
  if (model === "gpt-6.1-sol") {
    // Match the candidate's captured effort in the article-quality screens.
    return { effort: "low" };
  }
  return undefined;
}
