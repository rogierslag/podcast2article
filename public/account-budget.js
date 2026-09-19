import { t, locale, localizedFetch } from "./localize.js";

const panel = document.querySelector("#account-budget");
const summary = panel.querySelector(".account-budget-summary");
const status = panel.querySelector(".account-budget-status");
const breakdown = panel.querySelector(".account-budget-breakdown");
const money = new Intl.NumberFormat(locale, {
  style: "currency",
  currency: "USD",
});
let refreshing = false;

function renderBudget(budget) {
  summary.textContent = t("budget.summary", {
    amount: money.format(budget.spentUsd),
  });
  status.textContent =
    budget.limitUsd === null
      ? t("budget.unlimited")
      : t("budget.available", { amount: money.format(budget.remainingUsd) });
  const rows = [
    [t("budget.spent"), money.format(budget.spentUsd)],
    [t("budget.historical"), money.format(budget.historicalSpendUsd)],
    [t("budget.counted"), money.format(budget.countedSpendUsd)],
    [t("budget.reserved"), money.format(budget.reservedUsd)],
    [
      t("budget.limit"),
      budget.limitUsd === null
        ? t("budget.unlimited")
        : money.format(budget.limitUsd),
    ],
  ];
  const list = document.createElement("dl");
  for (const [label, amount] of rows) {
    const term = document.createElement("dt");
    term.textContent = label;
    const value = document.createElement("dd");
    value.textContent = amount;
    list.append(term, value);
  }
  const note = document.createElement("p");
  note.textContent = t("budget.explanation");
  breakdown.replaceChildren(list, note);
  if (budget.unknownCostRequests > 0) {
    const unknown = document.createElement("p");
    unknown.textContent = t("budget.unknown", {
      count: budget.unknownCostRequests,
    });
    breakdown.append(unknown);
  }
}

async function refreshBudget() {
  if (refreshing || document.hidden) {
    return;
  }
  refreshing = true;
  try {
    const response = await localizedFetch("/api/account-budget", {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error("Account budget unavailable");
    }
    renderBudget(await response.json());
  } catch {
    summary.textContent = t("budget.unavailable");
    status.textContent = "";
    breakdown.replaceChildren();
  } finally {
    refreshing = false;
  }
}

void refreshBudget();
setInterval(() => void refreshBudget(), 30_000);
window.addEventListener("focus", refreshBudget);
document.addEventListener("visibilitychange", refreshBudget);
panel.addEventListener("toggle", () => {
  if (panel.open) {
    void refreshBudget();
  }
});
