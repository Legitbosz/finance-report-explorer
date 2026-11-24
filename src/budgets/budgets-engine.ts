import type { Category, Day, Transaction } from '../../contracts/index.js';
import { getCategoryDisplayLabel } from '../../contracts/index.js';
import { CATEGORY_COLORS } from '../grid/interactive-grid.js';

export const BUDGETS_STORAGE_KEY = 'finance_story_budgets_v1';

export type BudgetStatus = 'unset' | 'on_track' | 'near_limit' | 'over_budget';

export interface BudgetStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface DiscoveredBudgetCategory {
  budgetKey: string;
  category: Category;
  rawLabel: string;
  displayLabel: string;
  color: string;
}

export interface CategoryBudgetRow extends DiscoveredBudgetCategory {
  budgetMinor: number | null;
  actualMinor: number;
  remainingMinor: number | null;
  percentUsed: number;
  progressWidthPct: number;
  status: BudgetStatus;
  statusLabel: string;
  projectedMinor: number;
  projectedExceeds: boolean;
  projectedExcessMinor: number;
  txnCount: number;
  txnIds: string[];
}

export interface BudgetOverviewSummary {
  selectedMonth: string;
  selectedMonthLabel: string;
  availableMonths: { value: string; label: string }[];
  daysInMonth: number;
  daysElapsed: number;
  asOfDateLabel: string;
  isPartialMonth: boolean;
  categories: CategoryBudgetRow[];
  configuredCount: number;
  totalBudgetMinor: number;
  totalBudgetedActualMinor: number;
  totalAllActualMinor: number;
  totalRemainingMinor: number;
  totalBudgetedProjectedMinor: number;
  totalAllProjectedMinor: number;
  nearLimitCount: number;
  overBudgetCount: number;
  projectedWarningCount: number;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function resolveStorage(override?: BudgetStorageLike | null): BudgetStorageLike | null {
  if (override !== undefined) return override;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore restricted storage access
  }
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      const ls = (globalThis as unknown as { localStorage?: BudgetStorageLike }).localStorage;
      if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
        return ls;
      }
    }
  } catch {
    // Ignore restricted storage access
  }
  return null;
}

export function loadSavedBudgets(storageOverride?: BudgetStorageLike | null): Record<string, number> {
  const storage = resolveStorage(storageOverride);
  if (!storage) return {};
  try {
    const raw = storage.getItem(BUDGETS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean: Record<string, number> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        clean[key] = Math.round(val);
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export function persistSavedBudgets(
  budgets: Record<string, number>,
  storageOverride?: BudgetStorageLike | null
): Record<string, number> {
  const clean: Record<string, number> = {};
  for (const [key, val] of Object.entries(budgets)) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      clean[key] = Math.round(val);
    }
  }
  const storage = resolveStorage(storageOverride);
  if (storage) {
    try {
      storage.setItem(BUDGETS_STORAGE_KEY, JSON.stringify(clean));
    } catch {
      // Ignore storage quota errors cleanly
    }
  }
  return clean;
}

export function saveBudgetLimit(
  budgetKey: string,
  budgetMinor: number,
  storageOverride?: BudgetStorageLike | null
): Record<string, number> {
  const current = loadSavedBudgets(storageOverride);
  const rounded = Math.round(budgetMinor);
  if (Number.isFinite(rounded) && rounded > 0) {
    current[budgetKey] = rounded;
  } else {
    delete current[budgetKey];
  }
  return persistSavedBudgets(current, storageOverride);
}

export function removeBudgetLimit(
  budgetKey: string,
  storageOverride?: BudgetStorageLike | null
): Record<string, number> {
  const current = loadSavedBudgets(storageOverride);
  delete current[budgetKey];
  return persistSavedBudgets(current, storageOverride);
}

export function formatBudgetCategoryTitle(rawLabel: string): string {
  const trimmed = rawLabel.trim();
  if (!trimmed) return 'Expense';
  // Preserve mixed-case labels (e.g. "Cloud & SaaS Stack") or short acronyms ("IT", "HR")
  const hasLowercase = /[a-z]/.test(trimmed);
  if (hasLowercase || trimmed.length <= 2) {
    return trimmed;
  }
  // Format ALL-CAPS category codes like "FOOD", "HOUSING", "OFFICE SUPPLIES" into natural Title Case
  return trimmed
    .toLowerCase()
    .replace(/\b([a-z])/g, (_m, c: string) => c.toUpperCase());
}

export function getBudgetKeyForTransaction(t: Pick<Transaction, 'category' | 'category_label'>): string {
  const rawLabel = t.category_label?.trim() ?? '';
  return rawLabel ? `${t.category}::${rawLabel.toLowerCase()}` : t.category;
}

export function extractBudgetCategories(
  transactions: readonly Transaction[],
  categoryLabels?: Record<string, string>,
  isB2B = false
): DiscoveredBudgetCategory[] {
  const outTxns = transactions.filter((t) => t.direction === 'out' && !t.is_transfer);
  const map = new Map<string, DiscoveredBudgetCategory>();

  for (const t of outTxns) {
    const rawLabel = t.category_label?.trim() ?? '';
    const budgetKey = getBudgetKeyForTransaction(t);
    if (!map.has(budgetKey)) {
      const displayLabel = rawLabel
        ? formatBudgetCategoryTitle(rawLabel)
        : formatBudgetCategoryTitle(getCategoryDisplayLabel(t.category, categoryLabels, isB2B));
      map.set(budgetKey, {
        budgetKey,
        category: t.category,
        rawLabel,
        displayLabel,
        color: CATEGORY_COLORS[t.category] ?? '#F4F03A',
      });
    }
  }

  return [...map.values()];
}

export function formatMonthLabel(ym: string): string {
  const [yStr, mStr] = ym.split('-');
  const year = Number(yStr);
  const monthIdx = Number(mStr) - 1;
  const monthName = MONTH_NAMES[monthIdx];
  if (!monthName || Number.isNaN(year)) return ym;
  return `${monthName} ${year}`;
}

export function getDaysInMonth(ym: string): number {
  const [yStr, mStr] = ym.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
    return 30;
  }
  return new Date(year, month, 0).getDate();
}

export function formatIsoDateShort(isoDate: string): string {
  const [yStr, mStr, dStr] = isoDate.split('-');
  const monthIdx = Number(mStr) - 1;
  const day = Number(dStr);
  const monthName = MONTH_NAMES[monthIdx]?.slice(0, 3);
  if (!monthName || Number.isNaN(day) || !yStr) return isoDate;
  return `${monthName} ${day}, ${yStr}`;
}

export function listAvailableMonths(
  transactions: readonly Transaction[],
  days: readonly Day[]
): { months: string[]; defaultMonth: string; latestDate: string } {
  const allMonthSet = new Set<string>();
  const expenseMonthSet = new Set<string>();
  let latestDate = '';

  for (const t of transactions) {
    if (t.date && t.date.length >= 7) {
      const ym = t.date.slice(0, 7);
      allMonthSet.add(ym);
      if (t.direction === 'out' && !t.is_transfer) {
        expenseMonthSet.add(ym);
      }
      if (!latestDate || t.date > latestDate) {
        latestDate = t.date;
      }
    }
  }

  if (allMonthSet.size === 0) {
    for (const d of days) {
      if (d.date && d.date.length >= 7) {
        allMonthSet.add(d.date.slice(0, 7));
        if (d.all_out_minor > 0) {
          expenseMonthSet.add(d.date.slice(0, 7));
        }
        if (!latestDate || d.date > latestDate) {
          latestDate = d.date;
        }
      }
    }
  }

  const months = [...allMonthSet].sort((a, b) => b.localeCompare(a));
  const expenseMonths = [...expenseMonthSet].sort((a, b) => b.localeCompare(a));
  const fallbackYm = '2025-01';
  const defaultMonth = expenseMonths[0] ?? months[0] ?? fallbackYm;
  return {
    months: months.length > 0 ? months : [defaultMonth],
    defaultMonth,
    latestDate: latestDate || `${defaultMonth}-01`,
  };
}

export function computeBudgetOverview(params: {
  transactions: readonly Transaction[];
  days: readonly Day[];
  savedBudgets: Record<string, number>;
  selectedMonth?: string;
  categoryLabels?: Record<string, string>;
  isB2B?: boolean;
}): BudgetOverviewSummary {
  const { transactions, days, savedBudgets, categoryLabels, isB2B = false } = params;
  const { months, defaultMonth, latestDate } = listAvailableMonths(transactions, days);
  const selectedMonth =
    params.selectedMonth && months.includes(params.selectedMonth)
      ? params.selectedMonth
      : defaultMonth;

  const daysInMonth = getDaysInMonth(selectedMonth);
  const latestMonth = latestDate.slice(0, 7);

  let daysElapsed = daysInMonth;
  let asOfDate = `${selectedMonth}-${String(daysInMonth).padStart(2, '0')}`;
  if (selectedMonth >= latestMonth && latestDate.startsWith(selectedMonth)) {
    const dayNum = Number(latestDate.slice(8, 10));
    if (Number.isFinite(dayNum) && dayNum >= 1) {
      daysElapsed = Math.min(daysInMonth, Math.max(1, dayNum));
      asOfDate = latestDate;
    }
  }

  const discovered = extractBudgetCategories(transactions, categoryLabels, isB2B);
  const outInMonth = transactions.filter(
    (t) =>
      t.direction === 'out' &&
      !t.is_transfer &&
      typeof t.date === 'string' &&
      t.date.startsWith(selectedMonth)
  );

  const spendByKey = new Map<string, { actualMinor: number; txnIds: string[] }>();
  for (const t of outInMonth) {
    const key = getBudgetKeyForTransaction(t);
    const entry = spendByKey.get(key) ?? { actualMinor: 0, txnIds: [] };
    entry.actualMinor += t.amount_minor;
    entry.txnIds.push(t.id);
    spendByKey.set(key, entry);
  }

  const rows: CategoryBudgetRow[] = discovered.map((cat) => {
    const spend = spendByKey.get(cat.budgetKey) ?? { actualMinor: 0, txnIds: [] };
    const actualMinor = spend.actualMinor;
    const rawSaved = savedBudgets[cat.budgetKey];
    const budgetMinor =
      typeof rawSaved === 'number' && Number.isFinite(rawSaved) && rawSaved > 0
        ? Math.round(rawSaved)
        : null;

    const remainingMinor = budgetMinor !== null ? budgetMinor - actualMinor : null;
    const ratio = budgetMinor !== null && budgetMinor > 0 ? actualMinor / budgetMinor : 0;
    const percentUsed = budgetMinor !== null && budgetMinor > 0 ? ratio * 100 : 0;
    const progressWidthPct =
      budgetMinor !== null && budgetMinor > 0 ? Math.min(100, Math.max(0, percentUsed)) : 0;

    let status: BudgetStatus = 'unset';
    let statusLabel = 'No budget';
    if (budgetMinor !== null) {
      if (actualMinor > budgetMinor) {
        status = 'over_budget';
        statusLabel = 'Over budget';
      } else if (ratio >= 0.8) {
        status = 'near_limit';
        statusLabel = 'Near limit';
      } else {
        status = 'on_track';
        statusLabel = 'On track';
      }
    }

    const projectedMinor =
      daysElapsed > 0 && daysElapsed < daysInMonth
        ? Math.round((actualMinor * daysInMonth) / daysElapsed)
        : actualMinor;
    const projectedExceeds = budgetMinor !== null && projectedMinor > budgetMinor;
    const projectedExcessMinor =
      budgetMinor !== null && projectedMinor > budgetMinor ? projectedMinor - budgetMinor : 0;

    return {
      ...cat,
      budgetMinor,
      actualMinor,
      remainingMinor,
      percentUsed,
      progressWidthPct,
      status,
      statusLabel,
      projectedMinor,
      projectedExceeds,
      projectedExcessMinor,
      txnCount: spend.txnIds.length,
      txnIds: spend.txnIds,
    };
  });

  rows.sort((a, b) => {
    if (b.actualMinor !== a.actualMinor) return b.actualMinor - a.actualMinor;
    const aHas = a.budgetMinor !== null ? 1 : 0;
    const bHas = b.budgetMinor !== null ? 1 : 0;
    if (bHas !== aHas) return bHas - aHas;
    return a.displayLabel.localeCompare(b.displayLabel);
  });

  let configuredCount = 0;
  let totalBudgetMinor = 0;
  let totalBudgetedActualMinor = 0;
  let totalAllActualMinor = 0;
  let totalBudgetedProjectedMinor = 0;
  let totalAllProjectedMinor = 0;
  let nearLimitCount = 0;
  let overBudgetCount = 0;
  let projectedWarningCount = 0;

  for (const row of rows) {
    totalAllActualMinor += row.actualMinor;
    totalAllProjectedMinor += row.projectedMinor;
    if (row.budgetMinor !== null) {
      configuredCount++;
      totalBudgetMinor += row.budgetMinor;
      totalBudgetedActualMinor += row.actualMinor;
      totalBudgetedProjectedMinor += row.projectedMinor;
      if (row.status === 'near_limit') nearLimitCount++;
      if (row.status === 'over_budget') overBudgetCount++;
      if (row.projectedExceeds) projectedWarningCount++;
    }
  }

  return {
    selectedMonth,
    selectedMonthLabel: formatMonthLabel(selectedMonth),
    availableMonths: months.map((m) => ({ value: m, label: formatMonthLabel(m) })),
    daysInMonth,
    daysElapsed,
    asOfDateLabel: formatIsoDateShort(asOfDate),
    isPartialMonth: daysElapsed < daysInMonth,
    categories: rows,
    configuredCount,
    totalBudgetMinor,
    totalBudgetedActualMinor,
    totalAllActualMinor,
    totalRemainingMinor: totalBudgetMinor - totalBudgetedActualMinor,
    totalBudgetedProjectedMinor,
    totalAllProjectedMinor,
    nearLimitCount,
    overBudgetCount,
    projectedWarningCount,
  };
}
