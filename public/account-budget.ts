import { responseData, budgetSchema } from "../src/shared/api.js";
import type { AccountBudget } from "../src/types.js";
import { requiredElement } from "./dom.js";
import { t, locale, localizedFetch } from "./localize.js";

const panel = requiredElement("#account-budget", HTMLDialogElement);
const summary = requiredElement(".account-budget-summary", HTMLElement, panel);
const status = requiredElement(".account-budget-status", HTMLElement, panel);
const breakdown = requiredElement(
  ".account-budget-breakdown",
  HTMLElement,
  panel,
);
const money = new Intl.NumberFormat(locale, {
  style: "currency",
  currency: "USD",
});
let refreshing = false;

function renderBudget(budget: AccountBudget) {
  summary.textContent = t("budget.summary", {
    amount: money.format(budget.spentUsd),
  });
  status.textContent =
    budget.limitUsd === null
      ? t("budget.unlimited")
      : t("budget.available", {
          amount: money.format(budget.remainingUsd ?? 0),
        });
  const rows: [string, string][] = [
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
    renderBudget(await responseData(response, budgetSchema));
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
const openButton = requiredElement("#account-budget-open", HTMLButtonElement);
const closeButton = requiredElement("#account-budget-close", HTMLButtonElement);
openButton.addEventListener("click", () => {
  panel.showModal();
  void refreshBudget();
});
closeButton.addEventListener("click", () => panel.close());
panel.addEventListener("close", () => openButton.focus());
