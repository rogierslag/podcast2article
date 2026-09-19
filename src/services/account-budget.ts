import type { AccountBudget, Job } from "../types.js";

export const accountLimitUsd = 5;
export const budgetWindowMs = 30 * 24 * 60 * 60 * 1000;

/** Operator-only configuration; never accept exemptions from a client payload. */
export function spendingLimitExempt(username: string): boolean {
  const users = (process.env.SPENDING_LIMIT_EXEMPT_USERS ?? "")
    .split(",")
    .map((user) => user.trim())
    .filter(Boolean);
  if (users.some((user) => !/^[a-z][a-z0-9_-]{1,31}$/.test(user))) {
    throw new Error(
      "SPENDING_LIMIT_EXEMPT_USERS must contain comma-separated account names.",
    );
  }
  return users.includes(username);
}

function validCost(amount: unknown): amount is number {
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0;
}

export function summarizeAccountBudget(
  jobs: Iterable<Job>,
  unlimited: boolean,
  now = Date.now(),
): AccountBudget {
  let countedSpendUsd = 0;
  let historicalSpendUsd = 0;
  let reservedUsd = 0;
  let unknownCostRequests = 0;
  for (const job of jobs) {
    if (job.savedShareKey) {
      continue;
    }
    for (const request of job.apiUsage?.requests ?? []) {
      const timestamp = Date.parse(request.finishedAt ?? request.startedAt);
      if (timestamp <= now - budgetWindowMs) {
        continue;
      }
      const cost = request.cost?.amount;
      const historical = request.reservedCostUsd === undefined;
      if (validCost(cost)) {
        if (historical) {
          historicalSpendUsd += cost;
        } else {
          countedSpendUsd += cost;
        }
      } else {
        unknownCostRequests += 1;
        if (!historical) {
          reservedUsd += validCost(request.reservedCostUsd)
            ? request.reservedCostUsd
            : accountLimitUsd;
        }
      }
    }
  }
  return {
    windowDays: 30,
    spentUsd: countedSpendUsd + historicalSpendUsd,
    countedSpendUsd,
    historicalSpendUsd,
    reservedUsd,
    unknownCostRequests,
    limitUsd: unlimited ? null : accountLimitUsd,
    remainingUsd: unlimited
      ? null
      : Math.max(0, accountLimitUsd - countedSpendUsd - reservedUsd),
  };
}

export class AccountBudgetError extends Error {
  constructor() {
    super("error.accountBudget");
    this.name = "AccountBudgetError";
  }
}

/** Include failed and deleted jobs; reading and sharing never transfer costs. */
export function accountSpend(jobs: Iterable<Job>, now = Date.now()): number {
  const summary = summarizeAccountBudget(jobs, false, now);
  return summary.countedSpendUsd + summary.reservedUsd;
}

export function assertAccountBudget(
  jobs: Iterable<Job>,
  reservation = 0,
  now = Date.now(),
): void {
  const spent = accountSpend(jobs, now);
  if (
    !Number.isFinite(reservation) ||
    reservation < 0 ||
    spent >= accountLimitUsd ||
    spent + reservation > accountLimitUsd
  ) {
    throw new AccountBudgetError();
  }
}
