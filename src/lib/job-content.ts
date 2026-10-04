import type { ArticleJob, Job } from "../types.js";

export function hasArticleContent(job: Job): job is ArticleJob {
  return Boolean(job.article && job.episode && job.transcript);
}
