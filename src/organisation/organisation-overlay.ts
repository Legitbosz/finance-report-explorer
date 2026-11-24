import gsap from 'gsap';
import { formatMoneyMinor } from '../../contracts/index.js';
import type { BudgetStorageLike } from '../budgets/budgets-engine.js';
import {
  cleanOrganisationState,
  computeOrganisationPerformance,
  createOrganisationId,
  loadSavedOrganisation,
  persistOrganisation,
  type OrganisationState,
  type OrganisationStatus,
  type PerformanceRow,
} from './organisation-engine.js';

export interface OrganisationOverlayCallbacks {
  onCloseOrganisation: () => void;
  onOpenBudgets: () => void;
  onLogEvent?: (type: string, value?: Record<string, unknown> | string | number) => void;
}

export class OrganisationOverlay {
  public readonly layerEl: HTMLElement;
  private readonly callbacks: OrganisationOverlayCallbacks;
  private readonly storageOverride?: BudgetStorageLike | null;

  private currencySymbol = '₦';
  private activeState = false;
  private state: OrganisationState = { branches: [], departments: [], units: [], staff: [] };
  private formError: string | null = null;

  constructor(
    overParent: HTMLElement,
    callbacks: OrganisationOverlayCallbacks,
    storageOverride?: BudgetStorageLike | null
  ) {
    this.callbacks = callbacks;
    this.storageOverride = storageOverride;
    this.state = loadSavedOrganisation(this.storageOverride);

    this.layerEl = document.createElement('div');
    this.layerEl.className = 'ch ia';
    this.layerEl.id = 'o-organisation';
    this.layerEl.dataset.testid = 'organisation-overlay';
    this.layerEl.style.cssText =
      'position:absolute;inset:0;visibility:hidden;pointer-events:none;background:var(--ink, #111111);color:var(--bone, #E8EEF2);z-index:12;';
    overParent.appendChild(this.layerEl);
  }

  public setCurrencySymbol(currencySymbol: string): void {
    this.currencySymbol = currencySymbol || '₦';
    if (this.activeState) this.render();
  }

  public setDataset(
    _days: readonly unknown[],
    _transactions: readonly unknown[],
    _categoryLabels?: Record<string, string>,
    _isB2B = false,
    currencySymbol?: string
  ): void {
    this.currencySymbol = currencySymbol || this.currencySymbol || '₦';
    if (this.activeState) this.render();
  }

  public isActive(): boolean {
    return this.activeState;
  }

  public open(): void {
    this.activeState = true;
    this.state = loadSavedOrganisation(this.storageOverride);
    this.formError = null;
    this.render();
    gsap.set(this.layerEl, { autoAlpha: 1 });
    this.layerEl.style.pointerEvents = 'auto';
    this.callbacks.onLogEvent?.('organisation.open');
  }

  public close(): void {
    if (!this.activeState) return;
    this.activeState = false;
    gsap.set(this.layerEl, { autoAlpha: 0 });
    this.layerEl.style.pointerEvents = 'none';
    this.callbacks.onLogEvent?.('organisation.close');
  }

  public getState(): OrganisationState {
    return cleanOrganisationState(this.state);
  }

  private formatAmount(amountMinor: number): string {
    const abs = Math.abs(Math.round(amountMinor));
    const showCents = abs % 100 !== 0;
    const formatted = formatMoneyMinor(abs, { showCents, prefix: '' });
    return `${amountMinor < 0 ? '-' : ''}${this.currencySymbol}${formatted}`;
  }

  private persist(): void {
    this.state = persistOrganisation(this.state, this.storageOverride);
  }

  private statusColor(status: OrganisationStatus): string {
    switch (status) {
      case 'over_budget':
        return '#E8799B';
      case 'near_limit':
        return '#6BE8F2';
      case 'on_track':
        return '#B9F0C6';
      default:
        return '#8A99A8';
    }
  }

  private render(): void {
    const perf = computeOrganisationPerformance(this.state);
    const branchOptions = this.state.branches
      .map(
        (b) =>
          `<option value="${this.escapeHtml(b.id)}">${this.escapeHtml(b.name)}${b.state ? ` (${this.escapeHtml(b.state)})` : ''}</option>`
      )
      .join('');
    const deptOptions = this.state.departments
      .map((d) => {
        const branch = this.state.branches.find((b) => b.id === d.branchId);
        return `<option value="${this.escapeHtml(d.id)}">${this.escapeHtml(d.name)}${branch ? ` · ${this.escapeHtml(branch.name)}` : ''}</option>`;
      })
      .join('');
    const unitOptions = this.state.units
      .map((u) => {
        const dept = this.state.departments.find((d) => d.id === u.departmentId);
        return `<option value="${this.escapeHtml(u.id)}">${this.escapeHtml(u.name)}${dept ? ` · ${this.escapeHtml(dept.name)}` : ''}</option>`;
      })
      .join('');

    const staffByUnit = new Map<string, string[]>();
    for (const member of this.state.staff) {
      const list = staffByUnit.get(member.unitId) ?? [];
      list.push(member.name);
      staffByUnit.set(member.unitId, list);
    }

    this.layerEl.innerHTML = `
      <div class="lab" style="position:absolute;left:64px;top:92px;">ORGANISATION · STAFF, DEPARTMENTS & BRANCHES</div>
      <div class="lab" style="position:absolute;left:64px;top:122px;font-size:12px;color:#AEBAC7;">${perf.totalStaff} STAFF · ${this.state.branches.length} BRANCHES · ${this.state.departments.length} DEPARTMENTS · ${this.state.units.length} UNITS · SAVED LOCALLY IN YOUR BROWSER</div>

      <div style="position:absolute;right:64px;top:86px;display:flex;gap:10px;align-items:center;pointer-events:auto;">
        <button type="button" class="btn" id="org-budgets-btn" data-testid="org-budgets-btn" style="border-color:var(--bone);color:var(--bone)">Budgets [B]</button>
        <button type="button" class="btn" id="org-close-btn" data-testid="org-close-btn" style="border-color:var(--bone);color:var(--bone)">← Back to story</button>
      </div>

      <div style="position:absolute;left:64px;right:64px;top:174px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;">
        <div data-testid="org-summary-allocated" style="background:var(--c1);color:var(--ink);padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;min-height:132px;">
          <div class="lab" style="font-size:11.5px;letter-spacing:0.12em;">TOTAL ALLOCATED</div>
          <div style="font-size:40px;font-weight:400;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1.05;">${this.escapeHtml(this.formatAmount(perf.totalAllocatedMinor))}</div>
          <div class="lab" style="font-size:11px;opacity:0.85;">ACROSS ALL UNITS</div>
        </div>
        <div data-testid="org-summary-actual" style="background:#131A21;border:1.5px solid #3A4552;color:var(--bone);padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;min-height:132px;">
          <div class="lab" style="font-size:11.5px;letter-spacing:0.12em;color:#AEBAC7;">TOTAL ACTUAL SPEND</div>
          <div style="font-size:40px;font-weight:400;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1.05;">${this.escapeHtml(this.formatAmount(perf.totalActualMinor))}</div>
          <div class="lab" style="font-size:11px;color:#AEBAC7;">${perf.totalAllocatedMinor > 0 ? `${((perf.totalActualMinor / perf.totalAllocatedMinor) * 100).toFixed(1)}% OF ALLOCATED` : 'NO BUDGETS SET YET'}</div>
        </div>
        <div data-testid="org-summary-best" style="background:#131A21;border:1.5px solid #3A4552;color:var(--bone);padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;min-height:132px;">
          <div class="lab" style="font-size:11.5px;letter-spacing:0.12em;color:#AEBAC7;">BEST PERFORMING UNIT</div>
          <div style="font-size:24px;font-weight:400;line-height:1.15;">${perf.bestUnits.length > 0 ? this.escapeHtml(perf.bestUnits[0]!.name) : '—'}</div>
          <div class="lab" style="font-size:11px;color:#B9F0C6;">${perf.bestUnits.length > 0 ? `${perf.bestUnits[0]!.percentUsed.toFixed(1)}% USED` : 'SET A UNIT BUDGET TO RANK'}</div>
        </div>
        <div data-testid="org-summary-worst" style="background:#131A21;border:1.5px solid #3A4552;color:var(--bone);padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;min-height:132px;">
          <div class="lab" style="font-size:11.5px;letter-spacing:0.12em;color:#AEBAC7;">WORST PERFORMING UNIT</div>
          <div style="font-size:24px;font-weight:400;line-height:1.15;">${perf.worstUnits.length > 0 ? this.escapeHtml(perf.worstUnits[0]!.name) : '—'}</div>
          <div class="lab" style="font-size:11px;color:#E8799B;">${perf.worstUnits.length > 0 ? `${perf.worstUnits[0]!.percentUsed.toFixed(1)}% USED` : 'SET A UNIT BUDGET TO RANK'}</div>
        </div>
      </div>

      <div data-testid="org-forms" style="position:absolute;left:64px;right:64px;top:330px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;">
        <div style="background:#131A21;border:1.5px solid #3A4552;padding:14px;display:flex;flex-direction:column;gap:8px;">
          <div class="lab" style="font-size:11px;color:#AEBAC7;">ADD BRANCH / REGION</div>
          <input id="org-branch-name" data-testid="org-branch-name" type="text" placeholder="e.g. Lagos HQ" style="padding:9px 10px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;" />
          <input id="org-branch-state" data-testid="org-branch-state" type="text" placeholder="State / region e.g. Lagos" style="padding:9px 10px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;" />
          <button type="button" class="btn primary" id="org-add-branch-btn" data-testid="org-add-branch-btn" style="background:var(--c1);color:var(--ink);border-color:var(--c1)">Add branch</button>
        </div>
        <div style="background:#131A21;border:1.5px solid #3A4552;padding:14px;display:flex;flex-direction:column;gap:8px;">
          <div class="lab" style="font-size:11px;color:#AEBAC7;">ADD DEPARTMENT</div>
          <select id="org-dept-branch" data-testid="org-dept-branch" style="padding:9px 10px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;">${branchOptions || '<option value="">Add a branch first</option>'}</select>
          <input id="org-dept-name" data-testid="org-dept-name" type="text" placeholder="e.g. Operations" style="padding:9px 10px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;" />
          <button type="button" class="btn primary" id="org-add-dept-btn" data-testid="org-add-dept-btn" style="background:var(--c1);color:var(--ink);border-color:var(--c1)">Add department</button>
        </div>
        <div style="background:#131A21;border:1.5px solid #3A4552;padding:14px;display:flex;flex-direction:column;gap:8px;">
          <div class="lab" style="font-size:11px;color:#AEBAC7;">ADD UNIT (BUDGET + ACTUAL)</div>
          <select id="org-unit-dept" data-testid="org-unit-dept" style="padding:9px 10px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;">${deptOptions || '<option value="">Add a department first</option>'}</select>
          <input id="org-unit-name" data-testid="org-unit-name" type="text" placeholder="e.g. Field Team" style="padding:9px 10px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;" />
          <div style="display:flex;gap:8px;">
            <input id="org-unit-allocated" data-testid="org-unit-allocated" type="number" min="0" step="any" placeholder="Budget" style="flex:1;min-width:0;padding:9px 10px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;" />
            <input id="org-unit-actual" data-testid="org-unit-actual" type="number" min="0" step="any" placeholder="Actual" style="flex:1;min-width:0;padding:9px 10px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;" />
          </div>
          <button type="button" class="btn primary" id="org-add-unit-btn" data-testid="org-add-unit-btn" style="background:var(--c1);color:var(--ink);border-color:var(--c1)">Add unit</button>
        </div>
        <div style="background:#131A21;border:1.5px solid #3A4552;padding:14px;display:flex;flex-direction:column;gap:8px;">
          <div class="lab" style="font-size:11px;color:#AEBAC7;">ADD STAFF</div>
          <input id="org-staff-name" data-testid="org-staff-name" type="text" placeholder="e.g. Ada Lovelace" style="padding:9px 10px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;" />
          <select id="org-staff-unit" data-testid="org-staff-unit" style="padding:9px 10px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;">${unitOptions || '<option value="">Add a unit first</option>'}</select>
          <button type="button" class="btn primary" id="org-add-staff-btn" data-testid="org-add-staff-btn" style="background:var(--c1);color:var(--ink);border-color:var(--c1)">Add staff</button>
        </div>
        ${this.formError ? `<div data-testid="org-form-error" style="grid-column:1 / -1;font-family:'JetBrains Mono',monospace;font-size:11px;color:#E8799B;">${this.escapeHtml(this.formError)}</div>` : ''}
      </div>

      <div style="position:absolute;left:64px;right:64px;top:560px;bottom:84px;overflow-y:auto;">
        ${this.renderPerformanceTable('BRANCHES', perf.branches, 'branch')}
        ${this.renderPerformanceTable('DEPARTMENTS', perf.departments, 'department')}
        ${this.renderPerformanceTable('UNITS', perf.units, 'unit', staffByUnit)}
        ${perf.units.length === 0 ? `<div style="padding:48px;border:1.5px solid #3A4552;background:#131A21;text-align:center;"><div style="font-size:24px;font-weight:400;margin-bottom:10px;">No units yet.</div><div class="lab" style="font-size:12px;color:#AEBAC7">Add a branch, then a department, then a unit with a budget and actual spend to see performance.</div></div>` : ''}
      </div>
    `;

    this.bindEvents();
  }

  private renderPerformanceTable(
    title: string,
    rows: PerformanceRow[],
    kind: 'branch' | 'department' | 'unit',
    staffByUnit?: Map<string, string[]>
  ): string {
    if (rows.length === 0) return '';
    return `
      <div style="margin-bottom:22px;">
        <div class="lab" style="font-size:11px;color:#AEBAC7;margin-bottom:10px;">${title} PERFORMANCE</div>
        <table data-testid="org-${kind}-table" style="width:100%;border-collapse:collapse;font-family:'JetBrains Mono',monospace;font-size:13px;">
          <thead>
            <tr style="text-align:left;color:#AEBAC7;text-transform:uppercase;font-size:11px;letter-spacing:0.08em;">
              <th style="padding:10px 12px;border-bottom:1.5px solid #3A4552;">Name</th>
              <th style="padding:10px 12px;border-bottom:1.5px solid #3A4552;text-align:right;">Allocated</th>
              <th style="padding:10px 12px;border-bottom:1.5px solid #3A4552;text-align:right;">Actual</th>
              <th style="padding:10px 12px;border-bottom:1.5px solid #3A4552;text-align:right;">Remaining</th>
              <th style="padding:10px 12px;border-bottom:1.5px solid #3A4552;text-align:right;">% used</th>
              <th style="padding:10px 12px;border-bottom:1.5px solid #3A4552;text-align:right;">Status</th>
              <th style="padding:10px 12px;border-bottom:1.5px solid #3A4552;text-align:right;"></th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
              <tr data-testid="org-${kind}-row-${this.escapeHtml(row.id)}">
                <td style="padding:10px 12px;border-bottom:1px solid #232A33;">
                  ${this.escapeHtml(row.name)}
                  <div style="font-size:11px;color:#8A99A8;">${this.escapeHtml(row.parentName)}${row.staffCount > 0 ? ` · ${row.staffCount} staff` : ''}${
                    kind === 'unit' && staffByUnit?.get(row.id)
                      ? ` · ${staffByUnit
                          .get(row.id)!
                          .map((n) => this.escapeHtml(n))
                          .join(', ')}`
                      : ''
                  }</div>
                </td>
                <td style="padding:10px 12px;border-bottom:1px solid #232A33;text-align:right;">${this.escapeHtml(this.formatAmount(row.allocatedMinor))}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #232A33;text-align:right;">${this.escapeHtml(this.formatAmount(row.actualMinor))}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #232A33;text-align:right;color:${row.remainingMinor < 0 ? '#E8799B' : '#B9F0C6'};">${this.escapeHtml(this.formatAmount(row.remainingMinor))}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #232A33;text-align:right;">${row.allocatedMinor > 0 ? `${row.percentUsed.toFixed(1)}%` : '—'}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #232A33;text-align:right;color:${this.statusColor(row.status)};">${this.escapeHtml(row.statusLabel)}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #232A33;text-align:right;"><button type="button" data-action="remove-${kind}" data-id="${this.escapeHtml(row.id)}" style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#E8799B;text-transform:uppercase;">Remove</button></td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`;
  }

  private bindEvents(): void {
    this.layerEl.querySelector('#org-close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onCloseOrganisation();
    });
    this.layerEl.querySelector('#org-budgets-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onOpenBudgets();
    });

    const getVal = (id: string): string =>
      this.layerEl.querySelector<HTMLInputElement>(`#${id}`)?.value.trim() ?? '';
    const getNum = (id: string): number => {
      const raw = getVal(id).replace(/[\s,]/g, '');
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
    };

    this.layerEl.querySelector('#org-add-branch-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = getVal('org-branch-name');
      const state = getVal('org-branch-state');
      if (!name) {
        this.formError = 'Enter a branch name.';
        this.render();
        return;
      }
      this.state.branches.push({ id: createOrganisationId('br'), name, state });
      this.formError = null;
      this.persist();
      this.render();
      this.callbacks.onLogEvent?.('organisation.add_branch', { name });
    });

    this.layerEl.querySelector('#org-add-dept-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const branchId =
        this.layerEl.querySelector<HTMLSelectElement>('#org-dept-branch')?.value ?? '';
      const name = getVal('org-dept-name');
      if (!branchId) {
        this.formError = 'Add a branch first, then add a department to it.';
        this.render();
        return;
      }
      if (!name) {
        this.formError = 'Enter a department name.';
        this.render();
        return;
      }
      this.state.departments.push({ id: createOrganisationId('dept'), branchId, name });
      this.formError = null;
      this.persist();
      this.render();
      this.callbacks.onLogEvent?.('organisation.add_department', { name });
    });

    this.layerEl.querySelector('#org-add-unit-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const departmentId =
        this.layerEl.querySelector<HTMLSelectElement>('#org-unit-dept')?.value ?? '';
      const name = getVal('org-unit-name');
      if (!departmentId) {
        this.formError = 'Add a department first, then add a unit to it.';
        this.render();
        return;
      }
      if (!name) {
        this.formError = 'Enter a unit name.';
        this.render();
        return;
      }
      this.state.units.push({
        id: createOrganisationId('unit'),
        departmentId,
        name,
        allocatedMinor: getNum('org-unit-allocated'),
        actualMinor: getNum('org-unit-actual'),
      });
      this.formError = null;
      this.persist();
      this.render();
      this.callbacks.onLogEvent?.('organisation.add_unit', { name });
    });

    this.layerEl.querySelector('#org-add-staff-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const unitId = this.layerEl.querySelector<HTMLSelectElement>('#org-staff-unit')?.value ?? '';
      const name = getVal('org-staff-name');
      if (!unitId) {
        this.formError = 'Add a unit first, then assign staff to it.';
        this.render();
        return;
      }
      if (!name) {
        this.formError = 'Enter a staff name.';
        this.render();
        return;
      }
      this.state.staff.push({ id: createOrganisationId('staff'), name, unitId });
      this.formError = null;
      this.persist();
      this.render();
      this.callbacks.onLogEvent?.('organisation.add_staff', { name });
    });

    this.layerEl
      .querySelectorAll<HTMLButtonElement>('[data-action="remove-branch"]')
      .forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          if (!id) return;
          const deptIds = new Set(
            this.state.departments.filter((d) => d.branchId === id).map((d) => d.id)
          );
          const unitIds = new Set(
            this.state.units.filter((u) => deptIds.has(u.departmentId)).map((u) => u.id)
          );
          this.state = {
            branches: this.state.branches.filter((b) => b.id !== id),
            departments: this.state.departments.filter((d) => d.branchId !== id),
            units: this.state.units.filter((u) => !deptIds.has(u.departmentId)),
            staff: this.state.staff.filter((m) => !unitIds.has(m.unitId)),
          };
          this.persist();
          this.render();
        });
      });
    this.layerEl
      .querySelectorAll<HTMLButtonElement>('[data-action="remove-department"]')
      .forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          if (!id) return;
          const unitIds = new Set(
            this.state.units.filter((u) => u.departmentId === id).map((u) => u.id)
          );
          this.state = {
            ...this.state,
            departments: this.state.departments.filter((d) => d.id !== id),
            units: this.state.units.filter((u) => u.departmentId !== id),
            staff: this.state.staff.filter((m) => !unitIds.has(m.unitId)),
          };
          this.persist();
          this.render();
        });
      });
    this.layerEl
      .querySelectorAll<HTMLButtonElement>('[data-action="remove-unit"]')
      .forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          if (!id) return;
          this.state = {
            ...this.state,
            units: this.state.units.filter((u) => u.id !== id),
            staff: this.state.staff.filter((m) => m.unitId !== id),
          };
          this.persist();
          this.render();
        });
      });
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
