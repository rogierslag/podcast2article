import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { messages, translate } from "../shared/i18n.js";

export interface AdminProblem {
  key: string;
  fingerprint: string;
  summary: string;
  details: string;
  route: string;
}

const id = z.string().uuid();
const jobSchema = z.object({
  id,
  stage: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().optional(),
  error: z.string().optional(),
  failedStage: z.string().optional(),
  episode: z.object({ title: z.string() }).optional(),
  apiUsage: z
    .object({
      requests: z.array(
        z.object({ status: z.string(), errorCode: z.string().optional() }),
      ),
    })
    .optional(),
});
const subscriptionsSchema = z.array(
  z.object({
    id,
    title: z.string(),
    error: z.string().optional(),
    paused: z.boolean().optional(),
  }),
);

function line(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").slice(0, 200);
}

function explanation(code?: string): string {
  if (code === "error.accountBudget") {
    return "The account spending allowance is exhausted. Check account usage before retrying.";
  }
  if (
    code &&
    Object.hasOwn(messages, code) &&
    /^(error|series\.error)/.test(code)
  ) {
    return translate("en", code);
  }
  return "Processing failed. Check the server logs for the underlying error before retrying.";
}

async function optionalJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Read only alert fields; never send stored jobs, transcripts, tokens or provider error bodies. */
export async function collectAdminProblems(
  root: string,
  usernames: string[],
): Promise<AdminProblem[]> {
  const problems: AdminProblem[] = [];
  for (const username of usernames) {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(username)) {
      throw new Error("Invalid alert account");
    }
    const directory = path.join(root, "users", username);
    const files = await readdir(path.join(directory, "jobs"), {
      withFileTypes: true,
    }).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    });
    for (const file of files) {
      if (
        !file.isFile() ||
        !file.name.endsWith(".json") ||
        !id.safeParse(file.name.slice(0, -5)).success
      ) {
        continue;
      }
      const job = jobSchema.parse(
        await optionalJson(path.join(directory, "jobs", file.name)),
      );
      if (job.id !== file.name.slice(0, -5)) {
        throw new Error("Alert job identity mismatch");
      }
      if (job.stage !== "failed" || job.deletedAt) {
        continue;
      }
      const lastRequest = job.apiUsage?.requests.at(-1);
      const quota =
        lastRequest?.status === "failed" &&
        lastRequest.errorCode === "insufficient_quota";
      const reason = quota
        ? "OpenAI credits or quota are exhausted. Check OpenAI billing, then retry the affected job."
        : explanation(job.error);
      const stage = [
        "queued",
        "resolving",
        "downloading",
        "transcribing",
        "writing",
      ].includes(job.failedStage ?? "")
        ? job.failedStage
        : "processing";
      problems.push({
        key: `job/${username}/${job.id}`,
        fingerprint: job.updatedAt,
        summary: `Job failed: ${line(job.episode?.title ?? job.id)}`,
        details: `Account: ${username}\nJob: ${job.id}\nFailed step: ${stage}\n${reason}`,
        route: `/#job=${job.id}`,
      });
    }
    const rawSubscriptions = await optionalJson(
      path.join(directory, "subscriptions.json"),
    );
    for (const subscription of subscriptionsSchema.parse(
      rawSubscriptions ?? [],
    )) {
      if (!subscription.error || subscription.paused) {
        continue;
      }
      problems.push({
        key: `series/${username}/${subscription.id}`,
        fingerprint: subscription.error,
        summary: `Series check failed: ${line(subscription.title)}`,
        details: `Account: ${username}\nSeries: ${subscription.id}\n${explanation(subscription.error)}\nThe next scheduled check will retry automatically.`,
        route: "/series",
      });
    }
  }
  const deployment = await optionalJson(
    path.join(root, "deployment-status.json"),
  );
  if (deployment !== undefined) {
    const status = z
      .object({
        failed: z.boolean(),
        targetCommit: z.string().nullable().optional(),
      })
      .parse(deployment);
    if (status.failed) {
      problems.push({
        key: "deployment",
        fingerprint: status.targetCommit ?? "failed",
        summary: "Deployment failed",
        details:
          "Check /var/log/podcast2article-update.log and the deployment service before retrying the update.",
        route: "/articles",
      });
    }
  }
  return problems;
}
