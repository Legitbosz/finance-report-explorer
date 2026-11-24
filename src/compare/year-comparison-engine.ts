import type { Transaction } from '../../contracts/index.js';
import {
  formatBudgetCategoryTitle,
  getBudgetKeyForTransaction,
  type BudgetStorageLike,
} from '../budgets/budgets-engine.js';

export const YEAR_COMPARISON_STORAGE_KEY = 'finance_story_year_comparison_v1';

export interface YearCategoryTotals {
  key: string;
  label: string;
  incomeMinor: number;
  expenseMinor: number;
  count: number;
}

export interface YearSummary {
  year: number;
  label: string;
  fileName: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  txnCount: number;
  inCount: number;
  outCount: number;
  byCategory: Record<string, YearCategoryTotals>;
}

export interface YearCategoryComparison {
  key: string;
  label: string;
  currentExpenseMinor: number;
  previousExpenseMinor: number;
  expenseDeltaMinor: number;
  expenseDeltaPct: number | null;
  currentIncomeMinor: number;
  previousIncomeMinor: number;
  incomeDeltaMinor: number;
  incomeDeltaPct: number | null;
  currentCount: number;
  previousCount: number;
}

export interface YearComparison {
  current: YearSummary;
  previous: YearSummary;
  incomeDeltaMinor: number;
  incomeDeltaPct: number | null;
  expenseDeltaMinor: number;
  expenseDeltaPct: number | null;
  netDeltaMinor: number;
  netImproved: boolean;
  categoryRows: YearCategoryComparison[];
  biggestExpenseGrowth: YearCategoryComparison | null;
  biggestExpenseFall: YearCategoryComparison | null;
  summaryText: string;
}

export type MoneyFormatter = (amountMinor: number) => string;

function defaultFormatMoney(amountMinor: number): string {
  const abs = Math.abs(Math.round(amountMinor));
  const dollars = Math.floor(abs / 100);
  const cents = abs % 100;
  const digits =
    cents === 0
      ? dollars.toLocaleString('en-US')
      : `${dollars.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`;
  return `${amountMinor < 0 ? '-' : ''}$${digits}`;
}

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

export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function computeYearSummary(
  transactions: readonly Transaction[],
  fileName = ''
): YearSummary | null {
  const dated = transactions.filter((t) => typeof t.date === 'string' && t.date.length >= 4);
  if (dated.length === 0) return null;

  const years = dated.map((t) => Number(t.date.slice(0, 4))).filter((y) => Number.isFinite(y));
  const year = years.length > 0 ? Math.max(...years) : new Date().getFullYear();

  const byCategory: Record<string, YearCategoryTotals> = {};
  let incomeMinor = 0;
  let expenseMinor = 0;
  let inCount = 0;
  let outCount = 0;

  for (const t of transactions) {
    if (t.is_transfer) continue;
    const key = getBudgetKeyForTransaction(t);
    const label = t.category_label?.trim()
      ? formatBudgetCategoryTitle(t.category_label.trim())
      : formatBudgetCategoryTitle(t.category);
    const entry = byCategory[key] ?? { key, label, incomeMinor: 0, expenseMinor: 0, count: 0 };
    if (t.direction === 'in') {
      incomeMinor += t.amount_minor;
      entry.incomeMinor += t.amount_minor;
      inCount++;
    } else {
      expenseMinor += t.amount_minor;
      entry.expenseMinor += t.amount_minor;
      outCount++;
    }
    entry.count++;
    byCategory[key] = entry;
  }

  return {
    year,
    label: String(year),
    fileName,
    incomeMinor,
    expenseMinor,
    netMinor: incomeMinor - expenseMinor,
    txnCount: inCount + outCount,
    inCount,
    outCount,
    byCategory,
  };
}

export function compareYearSummaries(
  current: YearSummary,
  previous: YearSummary,
  formatMoney: MoneyFormatter = defaultFormatMoney
): YearComparison {
  const incomeDeltaMinor = current.incomeMinor - previous.incomeMinor;
  const expenseDeltaMinor = current.expenseMinor - previous.expenseMinor;
  const netDeltaMinor = current.netMinor - previous.netMinor;
  const netImproved = netDeltaMinor > 0;

  const keys = new Set([...Object.keys(current.byCategory), ...Object.keys(previous.byCategory)]);
  const categoryRows: YearCategoryComparison[] = [...keys]
    .map((key) => {
      const cur = current.byCategory[key];
      const prev = previous.byCategory[key];
      const label = cur?.label ?? prev?.label ?? key;
      const currentExpenseMinor = cur?.expenseMinor ?? 0;
      const previousExpenseMinor = prev?.expenseMinor ?? 0;
      const currentIncomeMinor = cur?.incomeMinor ?? 0;
      const previousIncomeMinor = prev?.incomeMinor ?? 0;
      return {
        key,
        label,
        currentExpenseMinor,
        previousExpenseMinor,
        expenseDeltaMinor: currentExpenseMinor - previousExpenseMinor,
        expenseDeltaPct: pctChange(currentExpenseMinor, previousExpenseMinor),
        currentIncomeMinor,
        previousIncomeMinor,
        incomeDeltaMinor: currentIncomeMinor - previousIncomeMinor,
        incomeDeltaPct: pctChange(currentIncomeMinor, previousIncomeMinor),
        currentCount: cur?.count ?? 0,
        previousCount: prev?.count ?? 0,
      };
    })
    .filter((row) => row.currentExpenseMinor > 0 || row.previousExpenseMinor > 0)
    .sort((a, b) => b.expenseDeltaMinor - a.expenseDeltaMinor);

  const expenseRows = categoryRows.filter(
    (r) => r.currentExpenseMinor > 0 || r.previousExpenseMinor > 0
  );
  const biggestExpenseGrowth = expenseRows.find((r) => r.expenseDeltaMinor > 0) ?? null;
  const biggestExpenseFall = expenseRows.length > 0 ? expenseRows[expenseRows.length - 1]! : null;
  const fallIsReal =
    biggestExpenseFall && biggestExpenseFall.expenseDeltaMinor < 0 ? biggestExpenseFall : null;

  const netPart = netImproved
    ? `Net improved by ${formatMoney(netDeltaMinor)} vs ${previous.label}.`
    : netDeltaMinor < 0
      ? `Net fell by ${formatMoney(Math.abs(netDeltaMinor))} vs ${previous.label}.`
      : `Net is unchanged vs ${previous.label}.`;
  const growthPart = biggestExpenseGrowth
    ? ` ${biggestExpenseGrowth.label} grew the most, up ${formatMoney(biggestExpenseGrowth.expenseDeltaMinor)}${biggestExpenseGrowth.expenseDeltaPct !== null ? ` (${biggestExpenseGrowth.expenseDeltaPct >= 0 ? '+' : ''}${biggestExpenseGrowth.expenseDeltaPct.toFixed(0)}%)` : ''}.`
    : '';
  const fallPart = fallIsReal
    ? ` ${fallIsReal.label} fell the most, down ${formatMoney(Math.abs(fallIsReal.expenseDeltaMinor))}.`
    : '';

  return {
    current,
    previous,
    incomeDeltaMinor,
    incomeDeltaPct: pctChange(current.incomeMinor, previous.incomeMinor),
    expenseDeltaMinor,
    expenseDeltaPct: pctChange(current.expenseMinor, previous.expenseMinor),
    netDeltaMinor,
    netImproved,
    categoryRows,
    biggestExpenseGrowth,
    biggestExpenseFall: fallIsReal,
    summaryText: `${netPart}${growthPart}${fallPart}`,
  };
}

export function loadSavedYearComparison(
  storageOverride?: BudgetStorageLike | null
): YearSummary | null {
  const storage = resolveStorage(storageOverride);
  if (!storage) return null;
  try {
    const raw = storage.getItem(YEAR_COMPARISON_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const s = parsed as Partial<YearSummary>;
    if (
      typeof s.year !== 'number' ||
      typeof s.incomeMinor !== 'number' ||
      typeof s.expenseMinor !== 'number' ||
      typeof s.netMinor !== 'number'
    ) {
      return null;
    }
    return {
      year: s.year,
      label: typeof s.label === 'string' ? s.label : String(s.year),
      fileName: typeof s.fileName === 'string' ? s.fileName : '',
      incomeMinor: s.incomeMinor,
      expenseMinor: s.expenseMinor,
      netMinor: s.netMinor,
      txnCount: typeof s.txnCount === 'number' ? s.txnCount : 0,
      inCount: typeof s.inCount === 'number' ? s.inCount : 0,
      outCount: typeof s.outCount === 'number' ? s.outCount : 0,
      byCategory:
        s.byCategory && typeof s.byCategory === 'object'
          ? (s.byCategory as YearSummary['byCategory'])
          : {},
    };
  } catch {
    return null;
  }
}

export function saveYearComparison(
  summary: YearSummary,
  storageOverride?: BudgetStorageLike | null
): void {
  const storage = resolveStorage(storageOverride);
  if (!storage) return;
  try {
    storage.setItem(YEAR_COMPARISON_STORAGE_KEY, JSON.stringify(summary));
  } catch {
    // Ignore storage quota errors cleanly
  }
}

export function clearYearComparison(storageOverride?: BudgetStorageLike | null): void {
  const storage = resolveStorage(storageOverride);
  if (!storage) return;
  try {
    if (typeof storage.removeItem === 'function') {
      storage.removeItem(YEAR_COMPARISON_STORAGE_KEY);
    } else {
      storage.setItem(YEAR_COMPARISON_STORAGE_KEY, '');
    }
  } catch {
    // Ignore storage errors cleanly
  }
}
