import { describe, expect, it } from 'vitest';
import { ingestFilesDeterministically } from '../pipeline/ingest-business.js';
import type { BudgetStorageLike } from '../src/budgets/budgets-engine.js';
import {
  buildAllocationCsv,
  buildAllocationSummaryText,
  cleanAllocationState,
  computeAllocation,
  loadSavedAllocation,
  persistAllocation,
  type AllocationState,
} from '../src/allocation/allocation-engine.js';
import {
  cleanOrganisationState,
  computeOrganisationPerformance,
  loadSavedOrganisation,
  persistOrganisation,
  type OrganisationState,
} from '../src/organisation/organisation-engine.js';
import {
  compareYearSummaries,
  computeYearSummary,
  loadSavedYearComparison,
  saveYearComparison,
  type YearSummary,
} from '../src/compare/year-comparison-engine.js';

const LEDGER_2026_CSV = [
  'Date,Description,Category,Amount',
  '2026-01-05,Salary,INCOME,250000',
  '2026-01-15,Freelance,INCOME,60000',
  '2026-01-06,Rent - January,HOUSING,-85000',
  '2026-01-08,Market shopping - food,FOOD,-42000',
  '2026-01-22,Market shopping - food,FOOD,-38000',
  '2026-01-10,Transport,TRANSPORT,-15000',
  '2026-01-18,Data subscription,UTILITIES,-12000',
  '2026-01-25,Electricity bill,UTILITIES,-20000',
].join('\n');

const LEDGER_2025_CSV = [
  'Date,Description,Category,Amount',
  '2025-01-05,Salary,INCOME,200000',
  '2025-01-06,Rent - January,HOUSING,-70000',
  '2025-01-08,Market shopping - food,FOOD,-30000',
  '2025-01-10,Transport,TRANSPORT,-10000',
  '2025-01-18,Data subscription,UTILITIES,-10000',
].join('\n');

function createMemoryStorage(): BudgetStorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

function loadLedger(csv: string, name: string) {
  return ingestFilesDeterministically([{ name, content: csv, mimeType: 'text/csv' }]);
}

describe('Year vs Last Year comparison', () => {
  it('summarises the 2026 sample ledger with exact headline totals', () => {
    const bundle = loadLedger(LEDGER_2026_CSV, 'sample-ledger.csv');
    const summary = computeYearSummary(bundle.transactions, 'sample-ledger.csv');
    expect(summary).not.toBeNull();
    expect(summary!.year).toBe(2026);
    expect(summary!.incomeMinor).toBe(310_000 * 100);
    expect(summary!.expenseMinor).toBe(212_000 * 100);
    expect(summary!.netMinor).toBe(98_000 * 100);
    expect(summary!.txnCount).toBe(8);
  });

  it('compares 2026 vs 2025 with correct deltas, percentages and summary text', () => {
    const current = computeYearSummary(loadLedger(LEDGER_2026_CSV, '2026.csv').transactions)!;
    const previous = computeYearSummary(loadLedger(LEDGER_2025_CSV, '2025.csv').transactions)!;
    const comparison = compareYearSummaries(
      current,
      previous,
      (m) => `₦${(m / 100).toLocaleString('en-US')}`
    );

    expect(comparison.incomeDeltaMinor).toBe(110_000 * 100);
    expect(comparison.incomeDeltaPct).toBeCloseTo(55, 5);
    expect(comparison.expenseDeltaMinor).toBe(92_000 * 100);
    expect(comparison.netDeltaMinor).toBe(18_000 * 100);
    expect(comparison.netImproved).toBe(true);

    const food = comparison.categoryRows.find((r) => r.label.toLowerCase().includes('food'));
    expect(food).toBeDefined();
    expect(food!.currentExpenseMinor).toBe(80_000 * 100);
    expect(food!.previousExpenseMinor).toBe(30_000 * 100);
    expect(food!.expenseDeltaMinor).toBe(50_000 * 100);
    expect(comparison.biggestExpenseGrowth?.label.toLowerCase()).toContain('food');
    expect(comparison.summaryText).toContain('Net improved');
    expect(comparison.summaryText).toContain('Food');
  });

  it('persists the last-year summary in localStorage and reloads it', () => {
    const storage = createMemoryStorage();
    const previous = computeYearSummary(loadLedger(LEDGER_2025_CSV, '2025.csv').transactions)!;
    saveYearComparison(previous, storage);
    const loaded: YearSummary | null = loadSavedYearComparison(storage);
    expect(loaded?.year).toBe(2025);
    expect(loaded?.expenseMinor).toBe(120_000 * 100);
    expect(loaded?.incomeMinor).toBe(200_000 * 100);
  });

  it('returns null for a ledger with no dated transactions', () => {
    expect(computeYearSummary([])).toBeNull();
  });
});

describe('Budget Allocation to departments', () => {
  const state: AllocationState = {
    totalMinor: 310_000 * 100,
    departments: [
      { id: 'd1', name: 'Operations', mode: 'percent', percent: 50, amountMinor: null },
      { id: 'd2', name: 'Marketing', mode: 'percent', percent: 30, amountMinor: null },
      { id: 'd3', name: 'Logistics', mode: 'amount', percent: null, amountMinor: 62_000 * 100 },
    ],
  };

  it('calculates % and fixed-amount shares, totals and remaining correctly', () => {
    const computed = computeAllocation(state);
    expect(computed.rows[0]!.computedMinor).toBe(155_000 * 100);
    expect(computed.rows[0]!.percentOfTotal).toBe(50);
    expect(computed.rows[1]!.computedMinor).toBe(93_000 * 100);
    expect(computed.rows[2]!.computedMinor).toBe(62_000 * 100);
    expect(computed.totalAllocatedMinor).toBe(310_000 * 100);
    expect(computed.totalAllocatedPct).toBeCloseTo(100, 5);
    expect(computed.remainingMinor).toBe(0);
    expect(computed.isOver).toBe(false);
  });

  it('warns when shares exceed 100% and reports the overage', () => {
    const over = computeAllocation({
      totalMinor: 100_000 * 100,
      departments: [
        { id: 'd1', name: 'A', mode: 'percent', percent: 70, amountMinor: null },
        { id: 'd2', name: 'B', mode: 'percent', percent: 50, amountMinor: null },
      ],
    });
    expect(over.isOver).toBe(true);
    expect(over.totalAllocatedPct).toBe(120);
    expect(over.remainingMinor).toBe(-20_000 * 100);
    expect(over.warnings.some((w) => w.includes('Over-allocated'))).toBe(true);
  });

  it('persists allocation state locally and drops invalid entries on load', () => {
    const storage = createMemoryStorage();
    persistAllocation(state, storage);
    expect(loadSavedAllocation(storage).departments).toHaveLength(3);
    expect(loadSavedAllocation(storage).totalMinor).toBe(310_000 * 100);

    const dirty = cleanAllocationState({
      totalMinor: -5,
      departments: [
        { id: 'x', name: '  ', mode: 'percent', percent: 10, amountMinor: null },
        { id: 'y', name: 'Valid', mode: 'percent', percent: 25, amountMinor: null },
      ],
    });
    expect(dirty.totalMinor).toBe(0);
    expect(dirty.departments).toHaveLength(1);
    expect(dirty.departments[0]!.name).toBe('Valid');
  });

  it('builds a copyable text summary and a CSV export that add up', () => {
    const computed = computeAllocation(state);
    const text = buildAllocationSummaryText(
      state,
      computed,
      (m) => `₦${(m / 100).toLocaleString('en-US')}`
    );
    expect(text).toContain('Operations: ₦155,000 (50.0%)');
    expect(text).toContain('Total budget: ₦310,000');
    const csv = buildAllocationCsv(state, computed, (m) => `₦${(m / 100).toLocaleString('en-US')}`);
    expect(csv).toContain('Department,Mode,Share,Amount');
    expect(csv).toContain('Operations,percent,50%,');
    expect(csv).toContain('Logistics,amount,');
  });
});

describe('Organisation staff, departments, units and branches', () => {
  function buildState(): OrganisationState {
    return {
      branches: [
        { id: 'b1', name: 'Lagos HQ', state: 'Lagos' },
        { id: 'b2', name: 'Abuja Office', state: 'FCT' },
      ],
      departments: [
        { id: 'd1', branchId: 'b1', name: 'Operations' },
        { id: 'd2', branchId: 'b2', name: 'Sales' },
      ],
      units: [
        {
          id: 'u1',
          departmentId: 'd1',
          name: 'Field Team',
          allocatedMinor: 100_000 * 100,
          actualMinor: 85_000 * 100,
        },
        {
          id: 'u2',
          departmentId: 'd1',
          name: 'Logistics',
          allocatedMinor: 50_000 * 100,
          actualMinor: 60_000 * 100,
        },
        {
          id: 'u3',
          departmentId: 'd2',
          name: 'Retail',
          allocatedMinor: 80_000 * 100,
          actualMinor: 40_000 * 100,
        },
      ],
      staff: [
        { id: 's1', name: 'Ada', unitId: 'u1' },
        { id: 's2', name: 'Bola', unitId: 'u1' },
        { id: 's3', name: 'Chidi', unitId: 'u3' },
      ],
    };
  }

  it('aggregates unit performance up to departments and branches with correct statuses', () => {
    const perf = computeOrganisationPerformance(buildState());
    const field = perf.units.find((u) => u.name === 'Field Team')!;
    expect(field.percentUsed).toBe(85);
    expect(field.status).toBe('near_limit');
    expect(field.staffCount).toBe(2);
    const logistics = perf.units.find((u) => u.name === 'Logistics')!;
    expect(logistics.status).toBe('over_budget');
    expect(logistics.remainingMinor).toBe(-10_000 * 100);
    const ops = perf.departments.find((d) => d.name === 'Operations')!;
    expect(ops.allocatedMinor).toBe(150_000 * 100);
    expect(ops.actualMinor).toBe(145_000 * 100);
    const lagos = perf.branches.find((b) => b.name === 'Lagos HQ')!;
    expect(lagos.allocatedMinor).toBe(150_000 * 100);
    expect(lagos.staffCount).toBe(2);
    expect(perf.totalStaff).toBe(3);
    expect(perf.totalAllocatedMinor).toBe(230_000 * 100);
    expect(perf.totalActualMinor).toBe(185_000 * 100);
  });

  it('ranks worst and best performing units by % used', () => {
    const perf = computeOrganisationPerformance(buildState());
    expect(perf.worstUnits[0]!.name).toBe('Logistics');
    expect(perf.bestUnits[0]!.name).toBe('Retail');
  });

  it('marks units with no budget as unset and persists state locally', () => {
    const state = buildState();
    state.units.push({
      id: 'u4',
      departmentId: 'd2',
      name: 'New Unit',
      allocatedMinor: 0,
      actualMinor: 5_000 * 100,
    });
    const perf = computeOrganisationPerformance(state);
    expect(perf.units.find((u) => u.name === 'New Unit')!.status).toBe('unset');

    const storage = createMemoryStorage();
    persistOrganisation(state, storage);
    const loaded = loadSavedOrganisation(storage);
    expect(loaded.branches).toHaveLength(2);
    expect(loaded.staff).toHaveLength(3);
    expect(loaded.units.find((u) => u.name === 'Retail')!.actualMinor).toBe(40_000 * 100);
  });

  it('drops orphaned departments, units and staff when cleaning saved state', () => {
    const cleaned = cleanOrganisationState({
      branches: [{ id: 'b1', name: 'Lagos HQ', state: 'Lagos' }],
      departments: [
        { id: 'd1', branchId: 'b1', name: 'Operations' },
        { id: 'd9', branchId: 'missing', name: 'Orphan Dept' },
      ],
      units: [
        {
          id: 'u1',
          departmentId: 'd1',
          name: 'Field Team',
          allocatedMinor: 1000,
          actualMinor: 500,
        },
        {
          id: 'u9',
          departmentId: 'd9',
          name: 'Orphan Unit',
          allocatedMinor: 1000,
          actualMinor: 500,
        },
      ],
      staff: [
        { id: 's1', name: 'Ada', unitId: 'u1' },
        { id: 's9', name: 'Ghost', unitId: 'u9' },
      ],
    });
    expect(cleaned.departments).toHaveLength(1);
    expect(cleaned.units).toHaveLength(1);
    expect(cleaned.staff).toHaveLength(1);
  });
});
