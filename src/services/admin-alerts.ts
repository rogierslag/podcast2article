import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { z } from "zod";
import { collectAdminProblems, type AdminProblem } from "./admin-problems.js";

const batchIntervalMs = 5 * 60_000;
const retryIntervalMs = 15 * 60_000;
const stateSchema = z.object({
  version: z.literal(1),
  nextSendAt: z.number().finite().nonnegative(),
  sent: z.record(z.string(), z.string()),
});
type AlertState = z.infer<typeof stateSchema>;
export interface AlertEmail {
  subject: string;
  text: string;
}
export interface AlertConfiguration {
  from: string;
  to: string;
  region: string;
  origin: string;
}

export function alertConfiguration(
  env = process.env,
): AlertConfiguration | undefined {
  if (!env.ADMIN_ALERT_EMAIL) {
    return undefined;
  }
  const from = z.email().parse(env.SES_FROM_EMAIL);
  const to = z.email().parse(env.ADMIN_ALERT_EMAIL);
  const region = z
    .string()
    .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
    .parse(env.SES_REGION);
  const url = new URL(env.PUBLIC_BASE_URL ?? "");
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "PUBLIC_BASE_URL must be an HTTP(S) origin for admin alerts",
    );
  }
  return { from, to, region, origin: url.origin };
}

export function sesAlertSender(
  config: AlertConfiguration,
): (email: AlertEmail) => Promise<void> {
  const client = new SESv2Client({ region: config.region, maxAttempts: 1 });
  return async (email) => {
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: config.from,
        Destination: { ToAddresses: [config.to] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: "UTF-8" },
            Body: { Text: { Data: email.text, Charset: "UTF-8" } },
          },
        },
      }),
      { abortSignal: AbortSignal.timeout(10_000) },
    );
  };
}

export function problemEmail(
  problems: AdminProblem[],
  origin: string,
): AlertEmail {
  return {
    subject: `Reads: ${problems.length} problem${problems.length === 1 ? " needs" : "s need"} attention`,
    text:
      [
        "Podcast2Article has encountered the following problems.",
        ...problems.map(
          (problem) =>
            `${problem.summary}\n${problem.details}\nOpen: ${origin}${problem.route}`,
        ),
        "Links require sign-in as the owning account. No paid work is restarted by this email.",
      ].join("\n\n") + "\n",
  };
}

/** One worker per data directory, like the application job store. */
export class AdminAlertWorker {
  private state?: AlertState;
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(
    private file: string,
    private collect: () => Promise<AdminProblem[]>,
    private send: (email: AlertEmail) => Promise<void>,
    private origin: string,
    private now = Date.now,
  ) {}

  start(): void {
    const tick = () => {
      void this.flush().catch(() => {
        // Do not log SDK errors, which can include the email request or credentials.
        console.error(
          "Admin alert check or delivery failed; pending problems will be retried.",
        );
      });
    };
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  async flush(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.running) {
      return this.running;
    }
    this.running = this.check();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async save(state: AlertState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, this.file);
    this.state = state;
  }

  private async check(): Promise<void> {
    if (!this.state) {
      try {
        this.state = stateSchema.parse(
          JSON.parse(await readFile(this.file, "utf8")),
        );
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )) {
          throw error;
        }
        this.state = {
          version: 1,
          nextSendAt: this.now() + batchIntervalMs,
          sent: {},
        };
        await this.save(this.state);
      }
    }
    let complete = true;
    const problems = await this.collect().catch(() => {
      complete = false;
      console.error(
        "Admin alert scan failed; check stored job, series and deployment files.",
      );
      return [
        {
          key: "alert-scan",
          fingerprint: "unreadable",
          summary: "Problem monitoring could not read application state",
          details:
            "Check the server logs and stored job, series and deployment files. Other problem alerts may be delayed until this is fixed.",
          route: "/articles",
        },
      ];
    });
    const activeKeys = new Set(problems.map((problem) => problem.key));
    const sent = Object.fromEntries(
      Object.entries(this.state.sent).filter(
        ([key]) => !complete || activeKeys.has(key),
      ),
    );
    const pending = problems
      .filter((problem) => sent[problem.key] !== problem.fingerprint)
      .slice(0, 20);
    if (!pending.length || this.now() < this.state.nextSendAt) {
      if (Object.keys(sent).length !== Object.keys(this.state.sent).length) {
        await this.save({ ...this.state, sent });
      }
      return;
    }
    // Persist a cooldown before transmission so a crash cannot cause a tight resend loop.
    await this.save({
      ...this.state,
      sent,
      nextSendAt: this.now() + retryIntervalMs,
    });
    await this.send(problemEmail(pending, this.origin));
    for (const problem of pending) {
      sent[problem.key] = problem.fingerprint;
    }
    await this.save({
      version: 1,
      sent,
      nextSendAt: this.now() + batchIntervalMs,
    });
    console.log(`Admin alert accepted by SES: ${pending.length} problem(s)`);
  }
}

export function startAdminAlerts(
  usernames: string[],
): (() => Promise<void>) | undefined {
  const config = alertConfiguration();
  if (!config) {
    return undefined;
  }
  const root = path.resolve("data");
  const worker = new AdminAlertWorker(
    path.join(root, "admin-alerts", "state.json"),
    () => collectAdminProblems(root, usernames),
    sesAlertSender(config),
    config.origin,
  );
  worker.start();
  return () => worker.stop();
}
