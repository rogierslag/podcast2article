import { appendFile, mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const webVitalSchema = z
  .object({
    name: z.enum(["LCP", "CLS", "INP"]),
    value: z.number().min(0).max(3_600_000),
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w-]+$/),
    sequence: z.number().int().min(1).max(1_000_000),
    navigationType: z.enum([
      "navigate",
      "reload",
      "back-forward",
      "back-forward-cache",
      "prerender",
      "restore",
      "soft-navigation",
    ]),
    page: z.enum([
      "login",
      "new-article",
      "articles",
      "article",
      "series",
      "shared-article",
      "shared-not-found",
    ]),
    layout: z.enum(["narrow", "wide"]),
    release: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
  })
  .strict()
  .refine((report) => report.name !== "CLS" || report.value <= 100);

export type WebVitalReport = z.infer<typeof webVitalSchema>;

export class WebVitalsCapacityError extends Error {}

interface WebVitalsStoreOptions {
  directory: string;
  now?: () => Date;
  maxDailyBytes?: number;
}

export class WebVitalsStore {
  private operation: Promise<void> = Promise.resolve();
  private prunedDay?: string;
  private readonly now: () => Date;
  private readonly maxDailyBytes: number;

  constructor(private readonly options: WebVitalsStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxDailyBytes = options.maxDailyBytes ?? 10 * 1024 * 1024;
  }

  record(report: WebVitalReport): Promise<void> {
    const operation = this.operation.then(() => this.append(report));
    // A failed append must not prevent later requests from trying again.
    this.operation = operation.catch(() => undefined);
    return operation;
  }

  flush(): Promise<void> {
    return this.operation;
  }

  private async append(report: WebVitalReport): Promise<void> {
    const receivedAt = this.now();
    const day = receivedAt.toISOString().slice(0, 10);
    const directory = this.options.directory;
    await mkdir(directory, { recursive: true });
    if (this.prunedDay !== day) {
      const oldestDay = new Date(receivedAt);
      oldestDay.setUTCDate(oldestDay.getUTCDate() - 29);
      const cutoff = oldestDay.toISOString().slice(0, 10);
      for (const filename of await readdir(directory)) {
        if (
          /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(filename) &&
          filename.slice(0, 10) < cutoff
        ) {
          await rm(path.join(directory, filename));
        }
      }
      this.prunedDay = day;
    }
    const file = path.join(directory, `${day}.jsonl`);
    let size = 0;
    let needsSeparator = false;
    try {
      const handle = await open(file, "r");
      try {
        size = (await handle.stat()).size;
        if (size > 0) {
          const lastByte = Buffer.alloc(1);
          await handle.read(lastByte, 0, 1, size - 1);
          needsSeparator = lastByte[0] !== 10;
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
    // Isolate a crash-truncated previous append so the next accepted report remains readable.
    const line = `${needsSeparator ? "\n" : ""}${JSON.stringify({ ...report, receivedAt: receivedAt.toISOString() })}\n`;
    if (size + Buffer.byteLength(line) > this.maxDailyBytes) {
      throw new WebVitalsCapacityError(
        "Web Vitals daily storage limit reached",
      );
    }
    await appendFile(file, line, { mode: 0o600 });
  }
}
