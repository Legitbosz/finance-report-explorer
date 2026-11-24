import type { BudgetStorageLike } from '../budgets/budgets-engine.js';

export const ALLOCATION_STORAGE_KEY = 'finance_story_allocation_v1';

export type AllocationMode = 'percent' | 'amount';

export interface AllocationEntry {
  id: string;
  name: string;
  mode: AllocationMode;
  /** Share of the total budget, 0–100. Used when mode is 'percent'. */
  percent: number | null;
  /** Fixed amount in minor units. Used when mode is 'amount'. */
  amountMinor: number | null;
}

export interface AllocationState {
  totalMinor: number;
  departments: AllocationEntry[];
}

export interface AllocationRow {
  entry: AllocationEntry;
  computedMinor: number;
  percentOfTotal: number;
  isOverTotal: boolean;
}

export interface AllocationComputation {
  totalMinor: number;
  rows: AllocationRow[];
  totalAllocatedMinor: number;
  totalAllocatedPct: number;
  remainingMinor: number;
  remainingPct: number;
  isOver: boolean;
  warnings: string[];
}

export function createAllocationId(): string {
  return `alloc-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
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

export function cleanAllocationState(raw: unknown): AllocationState {
  const empty: AllocationState = { totalMinor: 0, departments: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const state = raw as Partial<AllocationState>;
  const totalMinor =
    typeof state.totalMinor === 'number' &&
    Number.isFinite(state.totalMinor) &&
    state.totalMinor > 0
      ? Math.round(state.totalMinor)
      : 0;
  const departments: AllocationEntry[] = [];
  if (Array.isArray(state.departments)) {
    for (const item of state.departments as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const d = item as Partial<AllocationEntry>;
      const name = typeof d.name === 'string' ? d.name.trim() : '';
      if (!name) continue;
      const mode: AllocationMode = d.mode === 'amount' ? 'amount' : 'percent';
      const percent =
        mode === 'percent' && typeof d.percent === 'number' && Number.isFinite(d.percent)
          ? Math.min(100, Math.max(0, d.percent))
          : null;
      const amountMinor =
        mode === 'amount' &&
        typeof d.amountMinor === 'number' &&
        Number.isFinite(d.amountMinor) &&
        d.amountMinor > 0
          ? Math.round(d.amountMinor)
          : null;
      if (mode === 'percent' && percent === null) continue;
      if (mode === 'amount' && amountMinor === null) continue;
      departments.push({
        id: typeof d.id === 'string' && d.id ? d.id : createAllocationId(),
        name,
        mode,
        percent,
        amountMinor,
      });
    }
  }
  return { totalMinor, departments };
}

export function loadSavedAllocation(storageOverride?: BudgetStorageLike | null): AllocationState {
  const storage = resolveStorage(storageOverride);
  if (!storage) return { totalMinor: 0, departments: [] };
  try {
    const raw = storage.getItem(ALLOCATION_STORAGE_KEY);
    if (!raw) return { totalMinor: 0, departments: [] };
    return cleanAllocationState(JSON.parse(raw) as unknown);
  } catch {
    return { totalMinor: 0, departments: [] };
  }
}

export function persistAllocation(
  state: AllocationState,
  storageOverride?: BudgetStorageLike | null
): AllocationState {
  const clean = cleanAllocationState(state);
  const storage = resolveStorage(storageOverride);
  if (storage) {
    try {
      storage.setItem(ALLOCATION_STORAGE_KEY, JSON.stringify(clean));
    } catch {
      // Ignore storage quota errors cleanly
    }
  }
  return clean;
}

export function computeAllocation(state: AllocationState): AllocationComputation {
  const totalMinor = state.totalMinor;
  const rows: AllocationRow[] = state.departments.map((entry) => {
    let computedMinor = 0;
    let percentOfTotal = 0;
    if (totalMinor > 0) {
      if (entry.mode === 'percent' && entry.percent !== null) {
        computedMinor = Math.round((totalMinor * entry.percent) / 100);
        percentOfTotal = entry.percent;
      } else if (entry.mode === 'amount' && entry.amountMinor !== null) {
        computedMinor = entry.amountMinor;
        percentOfTotal = (entry.amountMinor / totalMinor) * 100;
      }
    } else if (entry.mode === 'amount' && entry.amountMinor !== null) {
      computedMinor = entry.amountMinor;
    }
    return { entry, computedMinor, percentOfTotal, isOverTotal: false };
  });

  const totalAllocatedMinor = rows.reduce((sum, r) => sum + r.computedMinor, 0);
  const totalAllocatedPct =
    totalMinor > 0 ? (totalAllocatedMinor / totalMinor) * 100 : rows.length > 0 ? 0 : 0;
  const remainingMinor = totalMinor - totalAllocatedMinor;
  const remainingPct = totalMinor > 0 ? (remainingMinor / totalMinor) * 100 : 0;
  const isOver = totalAllocatedMinor > totalMinor || totalAllocatedPct > 100;

  const warnings: string[] = [];
  if (totalMinor <= 0 && rows.length > 0) {
    warnings.push('Set a total budget first — shares are calculated from it.');
  }
  if (isOver) {
    warnings.push('Over-allocated: departments add up to more than the total budget.');
  } else if (remainingMinor > 0 && rows.length > 0) {
    warnings.push('Unallocated: part of the total budget is not assigned to any department.');
  }

  return {
    totalMinor,
    rows,
    totalAllocatedMinor,
    totalAllocatedPct,
    remainingMinor,
    remainingPct,
    isOver,
    warnings,
  };
}

export type AllocationMoneyFormatter = (amountMinor: number) => string;

export function buildAllocationSummaryText(
  state: AllocationState,
  computed: AllocationComputation,
  formatMoney: AllocationMoneyFormatter
): string {
  const lines: string[] = [];
  lines.push('BUDGET ALLOCATION');
  lines.push(`Total budget: ${formatMoney(state.totalMinor)}`);
  lines.push(
    `Allocated: ${formatMoney(computed.totalAllocatedMinor)} (${computed.totalAllocatedPct.toFixed(1)}%)`
  );
  lines.push(`Remaining unallocated: ${formatMoney(computed.remainingMinor)}`);
  lines.push('');
  for (const row of computed.rows) {
    lines.push(
      `${row.entry.name}: ${formatMoney(row.computedMinor)} (${row.percentOfTotal.toFixed(1)}%)`
    );
  }
  if (computed.isOver) {
    lines.push('');
    lines.push('Warning: departments are over-allocated — shares exceed the total budget.');
  }
  return lines.join('\n');
}

export function buildAllocationCsv(
  state: AllocationState,
  computed: AllocationComputation,
  formatMoney: AllocationMoneyFormatter
): string {
  const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines: string[] = [
    'Department,Mode,Share,Amount',
    ...computed.rows.map((row) => {
      const share =
        row.entry.mode === 'percent' && row.entry.percent !== null
          ? `${row.entry.percent}%`
          : formatMoney(row.entry.amountMinor ?? 0);
      return [
        esc(row.entry.name),
        row.entry.mode,
        esc(share),
        esc(formatMoney(row.computedMinor)),
      ].join(',');
    }),
    `Total budget,,,${esc(formatMoney(state.totalMinor))}`,
    `Allocated,,,${esc(formatMoney(computed.totalAllocatedMinor))}`,
    `Remaining unallocated,,,${esc(formatMoney(computed.remainingMinor))}`,
  ];
  return lines.join('\n');
}
