type LogData = Record<string, string | number | boolean | undefined>;

function clean(value: unknown): string {
  return String(value)
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

function details(data?: LogData): string {
  if (!data) {
    return "";
  }
  const fields = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(clean(value))}`);
  return fields.length ? ` · ${fields.join(" ")}` : "";
}

export function jobLog(
  jobId: string,
  stage: string,
  message: string,
  data?: LogData,
): void {
  console.log(
    `${new Date().toISOString()} INFO  [job:${jobId}] [${stage}] ${clean(message)}${details(data)}`,
  );
}

export function jobError(jobId: string, stage: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `${new Date().toISOString()} ERROR [job:${jobId}] [${stage}] ${clean(message)}`,
  );
  if (
    error instanceof Error &&
    error.stack &&
    process.env.LOG_STACKS === "true"
  ) {
    console.error(error.stack);
  }
}
