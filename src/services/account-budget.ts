import type { Job } from "../types.js";

export const accountLimitUsd = 5;
export const budgetWindowMs = 30 * 24 * 60 * 60 * 1000;

export class AccountBudgetError extends Error {
  constructor() {
    super("error.accountBudget");
    this.name = "AccountBudgetError";
  }
}

/** Include failed and deleted jobs; reading and sharing never transfer costs. */
export function accountSpend(jobs: Iterable<Job>, now = Date.now()): number {
  const cutoff = now - budgetWindowMs;
  let total = 0;
  for (const job of jobs) {
    if (job.savedShareKey) {
      continue;
    }
    const usage = job.apiUsage;
    for (const request of usage?.requests ?? []) {
      // Historical requests predate budget reservations and are grandfathered.
      // Every new paid attempt persists this field before it can be sent.
      if (request.reservedCostUsd === undefined) {
        continue;
      }
      // Completion time prevents a long-running request ageing out prematurely.
      const timestamp = Date.parse(request.finishedAt ?? request.startedAt);
      if (timestamp <= cutoff) {
        continue;
      }
      const amount = request.cost.amount ?? request.reservedCostUsd;
      total +=
        amount !== undefined && Number.isFinite(amount) && amount >= 0
          ? amount
          : accountLimitUsd;
    }
  }
  return total;
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
