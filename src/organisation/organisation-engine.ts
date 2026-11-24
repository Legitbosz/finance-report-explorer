import type { BudgetStorageLike } from '../budgets/budgets-engine.js';

export const ORGANISATION_STORAGE_KEY = 'finance_story_organisation_v1';

export type OrganisationStatus = 'unset' | 'on_track' | 'near_limit' | 'over_budget';

export interface Branch {
  id: string;
  name: string;
  state: string;
}

export interface Department {
  id: string;
  branchId: string;
  name: string;
}

export interface Unit {
  id: string;
  departmentId: string;
  name: string;
  /** Budget allocated to this unit, in minor units. */
  allocatedMinor: number;
  /** Actual spend for this unit, in minor units (entered by the user). */
  actualMinor: number;
}

export interface StaffMember {
  id: string;
  name: string;
  unitId: string;
}

export interface OrganisationState {
  branches: Branch[];
  departments: Department[];
  units: Unit[];
  staff: StaffMember[];
}

export interface PerformanceRow {
  id: string;
  name: string;
  parentName: string;
  allocatedMinor: number;
  actualMinor: number;
  remainingMinor: number;
  percentUsed: number;
  status: OrganisationStatus;
  statusLabel: string;
  unitCount: number;
  staffCount: number;
}

export interface OrganisationPerformance {
  branches: PerformanceRow[];
  departments: PerformanceRow[];
  units: PerformanceRow[];
  bestUnits: PerformanceRow[];
  worstUnits: PerformanceRow[];
  totalAllocatedMinor: number;
  totalActualMinor: number;
  totalStaff: number;
}

export function createOrganisationId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
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

export function emptyOrganisationState(): OrganisationState {
  return { branches: [], departments: [], units: [], staff: [] };
}

function cleanMoney(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function cleanOrganisationState(raw: unknown): OrganisationState {
  const state = emptyOrganisationState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
  const s = raw as Partial<OrganisationState>;

  if (Array.isArray(s.branches)) {
    for (const item of s.branches as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const b = item as Partial<Branch>;
      const name = cleanName(b.name);
      if (!name) continue;
      state.branches.push({
        id: typeof b.id === 'string' && b.id ? b.id : createOrganisationId('br'),
        name,
        state: cleanName(b.state),
      });
    }
  }
  const branchIds = new Set(state.branches.map((b) => b.id));
  if (Array.isArray(s.departments)) {
    for (const item of s.departments as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const d = item as Partial<Department>;
      const name = cleanName(d.name);
      if (!name || typeof d.branchId !== 'string' || !branchIds.has(d.branchId)) continue;
      state.departments.push({
        id: typeof d.id === 'string' && d.id ? d.id : createOrganisationId('dept'),
        branchId: d.branchId,
        name,
      });
    }
  }
  const deptIds = new Set(state.departments.map((d) => d.id));
  if (Array.isArray(s.units)) {
    for (const item of s.units as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const u = item as Partial<Unit>;
      const name = cleanName(u.name);
      if (!name || typeof u.departmentId !== 'string' || !deptIds.has(u.departmentId)) continue;
      state.units.push({
        id: typeof u.id === 'string' && u.id ? u.id : createOrganisationId('unit'),
        departmentId: u.departmentId,
        name,
        allocatedMinor: cleanMoney(u.allocatedMinor),
        actualMinor: cleanMoney(u.actualMinor),
      });
    }
  }
  const unitIds = new Set(state.units.map((u) => u.id));
  if (Array.isArray(s.staff)) {
    for (const item of s.staff as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const m = item as Partial<StaffMember>;
      const name = cleanName(m.name);
      if (!name || typeof m.unitId !== 'string' || !unitIds.has(m.unitId)) continue;
      state.staff.push({
        id: typeof m.id === 'string' && m.id ? m.id : createOrganisationId('staff'),
        name,
        unitId: m.unitId,
      });
    }
  }
  return state;
}

export function loadSavedOrganisation(
  storageOverride?: BudgetStorageLike | null
): OrganisationState {
  const storage = resolveStorage(storageOverride);
  if (!storage) return emptyOrganisationState();
  try {
    const raw = storage.getItem(ORGANISATION_STORAGE_KEY);
    if (!raw) return emptyOrganisationState();
    return cleanOrganisationState(JSON.parse(raw) as unknown);
  } catch {
    return emptyOrganisationState();
  }
}

export function persistOrganisation(
  state: OrganisationState,
  storageOverride?: BudgetStorageLike | null
): OrganisationState {
  const clean = cleanOrganisationState(state);
  const storage = resolveStorage(storageOverride);
  if (storage) {
    try {
      storage.setItem(ORGANISATION_STORAGE_KEY, JSON.stringify(clean));
    } catch {
      // Ignore storage quota errors cleanly
    }
  }
  return clean;
}

export function statusForPercent(
  allocatedMinor: number,
  actualMinor: number
): {
  status: OrganisationStatus;
  statusLabel: string;
  percentUsed: number;
} {
  if (allocatedMinor <= 0) {
    return { status: 'unset', statusLabel: 'No budget', percentUsed: 0 };
  }
  const percentUsed = (actualMinor / allocatedMinor) * 100;
  if (actualMinor > allocatedMinor) {
    return { status: 'over_budget', statusLabel: 'Over budget', percentUsed };
  }
  if (percentUsed >= 80) {
    return { status: 'near_limit', statusLabel: 'Near limit', percentUsed };
  }
  return { status: 'on_track', statusLabel: 'On track', percentUsed };
}

export function computeOrganisationPerformance(state: OrganisationState): OrganisationPerformance {
  const staffByUnit = new Map<string, number>();
  for (const member of state.staff) {
    staffByUnit.set(member.unitId, (staffByUnit.get(member.unitId) ?? 0) + 1);
  }

  const deptById = new Map(state.departments.map((d) => [d.id, d]));
  const branchById = new Map(state.branches.map((b) => [b.id, b]));

  const makeRow = (
    id: string,
    name: string,
    parentName: string,
    allocatedMinor: number,
    actualMinor: number,
    unitCount: number,
    staffCount: number
  ): PerformanceRow => {
    const { status, statusLabel, percentUsed } = statusForPercent(allocatedMinor, actualMinor);
    return {
      id,
      name,
      parentName,
      allocatedMinor,
      actualMinor,
      remainingMinor: allocatedMinor - actualMinor,
      percentUsed,
      status,
      statusLabel,
      unitCount,
      staffCount,
    };
  };

  const units: PerformanceRow[] = state.units.map((unit) => {
    const dept = deptById.get(unit.departmentId);
    const branch = dept ? branchById.get(dept.branchId) : undefined;
    return makeRow(
      unit.id,
      unit.name,
      dept ? `${dept.name}${branch ? ` · ${branch.name}` : ''}` : '',
      unit.allocatedMinor,
      unit.actualMinor,
      1,
      staffByUnit.get(unit.id) ?? 0
    );
  });

  const departments: PerformanceRow[] = state.departments.map((dept) => {
    const deptUnits = state.units.filter((u) => u.departmentId === dept.id);
    const allocated = deptUnits.reduce((s, u) => s + u.allocatedMinor, 0);
    const actual = deptUnits.reduce((s, u) => s + u.actualMinor, 0);
    const staffCount = deptUnits.reduce((s, u) => s + (staffByUnit.get(u.id) ?? 0), 0);
    const branch = branchById.get(dept.branchId);
    return makeRow(
      dept.id,
      dept.name,
      branch ? `${branch.name}${branch.state ? ` · ${branch.state}` : ''}` : '',
      allocated,
      actual,
      deptUnits.length,
      staffCount
    );
  });

  const branches: PerformanceRow[] = state.branches.map((branch) => {
    const branchDepts = state.departments.filter((d) => d.branchId === branch.id);
    const deptIds = new Set(branchDepts.map((d) => d.id));
    const branchUnits = state.units.filter((u) => deptIds.has(u.departmentId));
    const allocated = branchUnits.reduce((s, u) => s + u.allocatedMinor, 0);
    const actual = branchUnits.reduce((s, u) => s + u.actualMinor, 0);
    const staffCount = branchUnits.reduce((s, u) => s + (staffByUnit.get(u.id) ?? 0), 0);
    return makeRow(
      branch.id,
      branch.name,
      branch.state,
      allocated,
      actual,
      branchUnits.length,
      staffCount
    );
  });

  const ranked = [...units]
    .filter((u) => u.allocatedMinor > 0)
    .sort((a, b) => b.percentUsed - a.percentUsed);
  const worstUnits = ranked.slice(0, 3);
  const bestUnits = [...ranked].reverse().slice(0, 3);

  return {
    branches,
    departments,
    units,
    bestUnits,
    worstUnits,
    totalAllocatedMinor: units.reduce((s, u) => s + u.allocatedMinor, 0),
    totalActualMinor: units.reduce((s, u) => s + u.actualMinor, 0),
    totalStaff: state.staff.length,
  };
}
