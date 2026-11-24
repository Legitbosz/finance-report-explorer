import gsap from 'gsap';
import { formatMoneyMinor } from '../../contracts/index.js';
import type { BudgetStorageLike } from '../budgets/budgets-engine.js';
import {
  buildAllocationCsv,
  buildAllocationSummaryText,
  cleanAllocationState,
  computeAllocation,
  createAllocationId,
  loadSavedAllocation,
  persistAllocation,
  type AllocationEntry,
  type AllocationMode,
  type AllocationState,
} from './allocation-engine.js';

export interface AllocationOverlayCallbacks {
  onCloseAllocation: () => void;
  onOpenBudgets: () => void;
  onLogEvent?: (type: string, value?: Record<string, unknown> | string | number) => void;
}

export class AllocationOverlay {
  public readonly layerEl: HTMLElement;
  private readonly callbacks: AllocationOverlayCallbacks;
  private readonly storageOverride?: BudgetStorageLike | null;

  private currencySymbol = '₦';
  private activeState = false;
  private state: AllocationState = { totalMinor: 0, departments: [] };
  private editingId: string | null = null;
  private formError: string | null = null;
  private copyMessage: string | null = null;

  constructor(
    overParent: HTMLElement,
    callbacks: AllocationOverlayCallbacks,
    storageOverride?: BudgetStorageLike | null
  ) {
    this.callbacks = callbacks;
    this.storageOverride = storageOverride;
    this.state = loadSavedAllocation(this.storageOverride);

    this.layerEl = document.createElement('div');
    this.layerEl.className = 'ch ia';
    this.layerEl.id = 'o-allocation';
    this.layerEl.dataset.testid = 'allocation-overlay';
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
    this.state = loadSavedAllocation(this.storageOverride);
    this.editingId = null;
    this.formError = null;
    this.copyMessage = null;
    this.render();
    gsap.set(this.layerEl, { autoAlpha: 1 });
    this.layerEl.style.pointerEvents = 'auto';
    this.callbacks.onLogEvent?.('allocation.open');
  }

  public close(): void {
    if (!this.activeState) return;
    this.activeState = false;
    gsap.set(this.layerEl, { autoAlpha: 0 });
    this.layerEl.style.pointerEvents = 'none';
    this.callbacks.onLogEvent?.('allocation.close');
  }

  public getState(): AllocationState {
    return cleanAllocationState(this.state);
  }

  private formatAmount(amountMinor: number): string {
    const abs = Math.abs(Math.round(amountMinor));
    const showCents = abs % 100 !== 0;
    const formatted = formatMoneyMinor(abs, { showCents, prefix: '' });
    return `${amountMinor < 0 ? '-' : ''}${this.currencySymbol}${formatted}`;
  }

  private persist(): void {
    this.state = persistAllocation(this.state, this.storageOverride);
  }

  private render(): void {
    const computed = computeAllocation(this.state);
    const totalStr =
      this.state.totalMinor > 0 ? this.formatAmount(this.state.totalMinor) : 'Not set';
    const editing = this.editingId
      ? this.state.departments.find((d) => d.id === this.editingId)
      : undefined;

    const rowsHtml =
      computed.rows.length === 0
        ? `<div style="grid-column:1 / -1;padding:48px;border:1.5px solid #3A4552;background:#131A21;text-align:center;">
             <div style="font-size:24px;font-weight:400;margin-bottom:10px;">No departments added yet.</div>
             <div class="lab" style="font-size:12px;color:#AEBAC7">Set a total budget, then add departments and give each one a % share or a fixed amount.</div>
           </div>`
        : computed.rows
            .map((row) => {
              const shareStr =
                row.entry.mode === 'percent' && row.entry.percent !== null
                  ? `${row.entry.percent}%`
                  : this.formatAmount(row.entry.amountMinor ?? 0);
              return `
              <article data-testid="allocation-row-${this.escapeHtml(row.entry.id)}" style="background:#131A21;border:1.5px solid ${computed.isOver ? '#E8799B' : '#3A4552'};padding:22px 24px;display:flex;flex-direction:column;gap:14px;">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
                  <div>
                    <h3 style="font-size:24px;font-weight:500;letter-spacing:-0.02em;">${this.escapeHtml(row.entry.name)}</h3>
                    <div class="lab" style="font-size:11px;color:#AEBAC7;margin-top:6px;">SHARE ${this.escapeHtml(shareStr)} · ${row.percentOfTotal.toFixed(1)}% OF TOTAL</div>
                  </div>
                  <div style="display:flex;gap:8px;flex-shrink:0;">
                    <button type="button" data-action="edit-department" data-dept-id="${this.escapeHtml(row.entry.id)}" style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;padding:7px 11px;border:1.5px solid var(--bone);color:var(--bone);">Edit</button>
                    <button type="button" data-action="remove-department" data-dept-id="${this.escapeHtml(row.entry.id)}" style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;padding:7px 11px;border:1.5px solid #E8799B;color:#E8799B;">Remove</button>
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:12px;">
                  <div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.round(row.percentOfTotal))}" style="flex:1;height:11px;background:#232A33;border:1px solid #3A4552;overflow:hidden;">
                    <div style="width:${Math.min(100, row.percentOfTotal).toFixed(1)}%;height:100%;background:${computed.isOver ? '#E8799B' : 'var(--c1)'};"></div>
                  </div>
                  <span style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:500;font-variant-numeric:tabular-nums;">${this.escapeHtml(this.formatAmount(row.computedMinor))}</span>
                </div>
              </article>`;
            })
            .join('');

    const warningsHtml = computed.warnings
      .map(
        (w) => `
        <div data-testid="allocation-warning" style="padding:10px 12px;border:1px solid ${computed.isOver ? '#E8799B' : '#38BDF8'};background:rgba(232,121,155,0.12);color:#A8C6F0;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.4;">
          ${this.escapeHtml(w)}${computed.isOver ? '' : ` Remaining: ${this.escapeHtml(this.formatAmount(computed.remainingMinor))} (${computed.remainingPct.toFixed(1)}%).`}
        </div>`
      )
      .join('');

    this.layerEl.innerHTML = `
      <div class="lab" style="position:absolute;left:64px;top:92px;">BUDGET ALLOCATION · DEPARTMENTS & UNITS</div>
      <div class="lab" style="position:absolute;left:64px;top:122px;font-size:12px;color:#AEBAC7;">SPLIT A TOTAL BUDGET ACROSS DEPARTMENTS · SAVED LOCALLY IN YOUR BROWSER</div>

      <div style="position:absolute;right:64px;top:86px;display:flex;gap:10px;align-items:center;pointer-events:auto;">
        <button type="button" class="btn" id="allocation-budgets-btn" data-testid="allocation-budgets-btn" style="border-color:var(--bone);color:var(--bone)">Budgets [B]</button>
        <button type="button" class="btn" id="allocation-close-btn" data-testid="allocation-close-btn" style="border-color:var(--bone);color:var(--bone)">← Back to story</button>
      </div>

      <div style="position:absolute;left:64px;right:64px;top:174px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;">
        <div data-testid="allocation-summary-total" style="background:var(--c1);color:var(--ink);padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;min-height:132px;">
          <div class="lab" style="font-size:11.5px;letter-spacing:0.12em;">TOTAL BUDGET</div>
          <div style="font-size:40px;font-weight:400;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1.05;">${this.escapeHtml(totalStr)}</div>
          <div class="lab" style="font-size:11px;opacity:0.85;">${computed.rows.length} DEPARTMENT${computed.rows.length === 1 ? '' : 'S'}</div>
        </div>
        <div data-testid="allocation-summary-allocated" style="background:#131A21;border:1.5px solid #3A4552;color:var(--bone);padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;min-height:132px;">
          <div class="lab" style="font-size:11.5px;letter-spacing:0.12em;color:#AEBAC7;">ALLOCATED</div>
          <div style="font-size:40px;font-weight:400;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1.05;">${this.escapeHtml(this.formatAmount(computed.totalAllocatedMinor))}</div>
          <div class="lab" style="font-size:11px;color:#AEBAC7;">${computed.totalAllocatedPct.toFixed(1)}% OF TOTAL</div>
        </div>
        <div data-testid="allocation-summary-remaining" style="background:#131A21;border:1.5px solid ${computed.isOver ? '#E8799B' : '#3A4552'};color:var(--bone);padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;min-height:132px;">
          <div class="lab" style="font-size:11.5px;letter-spacing:0.12em;color:#AEBAC7;">REMAINING UNALLOCATED</div>
          <div style="font-size:40px;font-weight:400;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1.05;color:${computed.isOver ? '#E8799B' : '#B9F0C6'};">${this.escapeHtml(this.formatAmount(computed.remainingMinor))}</div>
          <div class="lab" style="font-size:11px;color:${computed.isOver ? '#E8799B' : '#AEBAC7'};">${computed.isOver ? 'OVER-ALLOCATED' : `${computed.remainingPct.toFixed(1)}% UNALLOCATED`}</div>
        </div>
        <div style="background:#131A21;border:1.5px solid #3A4552;color:var(--bone);padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;min-height:132px;">
          <div class="lab" style="font-size:11.5px;letter-spacing:0.12em;color:#AEBAC7;">SHARE THIS SPLIT</div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button type="button" class="btn" id="allocation-copy-btn" data-testid="allocation-copy-btn" style="border-color:var(--bone);color:var(--bone);text-align:left;">Copy text summary</button>
            <button type="button" class="btn" id="allocation-csv-btn" data-testid="allocation-csv-btn" style="border-color:var(--bone);color:var(--bone);text-align:left;">Download CSV</button>
            <button type="button" class="btn" id="allocation-png-btn" data-testid="allocation-png-btn" style="border-color:var(--bone);color:var(--bone);text-align:left;">Download PNG card</button>
          </div>
          ${this.copyMessage ? `<div data-testid="allocation-copy-message" class="lab" style="font-size:11px;color:#B9F0C6;">${this.escapeHtml(this.copyMessage)}</div>` : ''}
        </div>
      </div>

      <div style="position:absolute;left:64px;right:64px;top:330px;display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
        <label class="lab" style="font-size:11px;color:#AEBAC7;display:flex;flex-direction:column;gap:6px;">TOTAL BUDGET (${this.escapeHtml(this.currencySymbol)})
          <input id="allocation-total-input" data-testid="allocation-total-input" type="number" min="1" step="any" value="${this.state.totalMinor > 0 ? this.escapeHtml(String(this.state.totalMinor / 100)) : ''}" placeholder="e.g. 310000" style="padding:10px 12px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:14px;outline:none;width:200px;" />
        </label>
        <button type="button" class="btn primary" id="allocation-total-save-btn" data-testid="allocation-total-save-btn" style="background:var(--c1);color:var(--ink);border-color:var(--c1)">Set total</button>
        ${warningsHtml}
      </div>

      <div data-testid="allocation-form" style="position:absolute;left:64px;right:64px;top:412px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;padding:14px;background:#131A21;border:1.5px solid #3A4552;">
        <label class="lab" style="font-size:11px;color:#AEBAC7;display:flex;flex-direction:column;gap:6px;flex:1;min-width:180px;">DEPARTMENT / UNIT NAME
          <input id="allocation-name-input" data-testid="allocation-name-input" type="text" value="${editing ? this.escapeHtml(editing.name) : ''}" placeholder="e.g. Operations" style="padding:10px 12px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:14px;outline:none;" />
        </label>
        <label class="lab" style="font-size:11px;color:#AEBAC7;display:flex;flex-direction:column;gap:6px;">SHARE TYPE
          <select id="allocation-mode-select" data-testid="allocation-mode-select" style="padding:10px 12px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:14px;outline:none;">
            <option value="percent" ${!editing || editing.mode === 'percent' ? 'selected' : ''}>% of total</option>
            <option value="amount" ${editing?.mode === 'amount' ? 'selected' : ''}>Fixed amount</option>
          </select>
        </label>
        <label class="lab" style="font-size:11px;color:#AEBAC7;display:flex;flex-direction:column;gap:6px;">VALUE
          <input id="allocation-value-input" data-testid="allocation-value-input" type="number" min="0" step="any" value="${editing ? this.escapeHtml(String(editing.mode === 'percent' ? (editing.percent ?? '') : editing.amountMinor !== null ? editing.amountMinor / 100 : '')) : ''}" placeholder="e.g. 50 or 100000" style="padding:10px 12px;border:1.5px solid var(--bone);background:#161E26;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:14px;outline:none;width:160px;" />
        </label>
        <button type="button" class="btn primary" id="allocation-add-btn" data-testid="allocation-add-btn" style="background:var(--c1);color:var(--ink);border-color:var(--c1)">${editing ? 'Save changes' : 'Add department'}</button>
        ${editing ? `<button type="button" class="btn" id="allocation-cancel-edit-btn" data-testid="allocation-cancel-edit-btn" style="border-color:#8A99A8;color:#AEBAC7;">Cancel</button>` : ''}
        ${this.formError ? `<div data-testid="allocation-form-error" style="flex-basis:100%;font-family:'JetBrains Mono',monospace;font-size:11px;color:#E8799B;">${this.escapeHtml(this.formError)}</div>` : ''}
      </div>

      <div id="allocation-rows-grid" data-testid="allocation-rows-grid" style="position:absolute;left:64px;right:64px;top:512px;bottom:84px;overflow-y:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;align-content:start;padding-right:4px;padding-bottom:16px;">
        ${rowsHtml}
      </div>
    `;

    this.bindEvents();
  }

  private bindEvents(): void {
    this.layerEl.querySelector('#allocation-close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onCloseAllocation();
    });
    this.layerEl.querySelector('#allocation-budgets-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onOpenBudgets();
    });
    this.layerEl.querySelector('#allocation-total-save-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = this.layerEl.querySelector<HTMLInputElement>('#allocation-total-input');
      const parsed = Number((input?.value ?? '').replace(/[\s,]/g, ''));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        this.formError = 'Enter a total budget greater than 0.';
        this.render();
        return;
      }
      this.state = { ...this.state, totalMinor: Math.round(parsed * 100) };
      this.formError = null;
      this.persist();
      this.render();
      this.callbacks.onLogEvent?.('allocation.set_total', { total_minor: this.state.totalMinor });
    });
    this.layerEl.querySelector('#allocation-add-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.commitDepartmentForm();
    });
    this.layerEl.querySelector('#allocation-cancel-edit-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.editingId = null;
      this.formError = null;
      this.render();
    });
    this.layerEl
      .querySelectorAll<HTMLButtonElement>('[data-action="edit-department"]')
      .forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.editingId = btn.dataset.deptId ?? null;
          this.formError = null;
          this.render();
          this.layerEl.querySelector<HTMLInputElement>('#allocation-name-input')?.focus();
        });
      });
    this.layerEl
      .querySelectorAll<HTMLButtonElement>('[data-action="remove-department"]')
      .forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.deptId;
          if (!id) return;
          this.state = {
            ...this.state,
            departments: this.state.departments.filter((d) => d.id !== id),
          };
          if (this.editingId === id) this.editingId = null;
          this.persist();
          this.render();
          this.callbacks.onLogEvent?.('allocation.remove', { id });
        });
      });
    this.layerEl.querySelector('#allocation-copy-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.copySummary();
    });
    this.layerEl.querySelector('#allocation-csv-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.downloadCsv();
    });
    this.layerEl.querySelector('#allocation-png-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.downloadPng();
    });
  }

  private commitDepartmentForm(): void {
    const nameInput = this.layerEl.querySelector<HTMLInputElement>('#allocation-name-input');
    const modeSelect = this.layerEl.querySelector<HTMLSelectElement>('#allocation-mode-select');
    const valueInput = this.layerEl.querySelector<HTMLInputElement>('#allocation-value-input');
    const name = (nameInput?.value ?? '').trim();
    const mode: AllocationMode = modeSelect?.value === 'amount' ? 'amount' : 'percent';
    const value = Number((valueInput?.value ?? '').replace(/[\s,]/g, ''));
    if (!name) {
      this.formError = 'Enter a department or unit name.';
      this.render();
      return;
    }
    if (!Number.isFinite(value) || value <= 0) {
      this.formError = 'Enter a share greater than 0.';
      this.render();
      return;
    }
    if (mode === 'percent' && value > 100) {
      this.formError = 'A % share cannot be more than 100.';
      this.render();
      return;
    }
    const entry: AllocationEntry = {
      id: this.editingId ?? createAllocationId(),
      name,
      mode,
      percent: mode === 'percent' ? value : null,
      amountMinor: mode === 'amount' ? Math.round(value * 100) : null,
    };
    const departments = this.editingId
      ? this.state.departments.map((d) => (d.id === this.editingId ? entry : d))
      : [...this.state.departments, entry];
    this.state = { ...this.state, departments };
    this.editingId = null;
    this.formError = null;
    this.copyMessage = null;
    this.persist();
    this.render();
    this.callbacks.onLogEvent?.('allocation.save_department', { name, mode });
  }

  private async copySummary(): Promise<void> {
    const computed = computeAllocation(this.state);
    const text = buildAllocationSummaryText(this.state, computed, (m) => this.formatAmount(m));
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        this.copyMessage = 'Copied — paste it anywhere to share the split.';
      } else {
        throw new Error('Clipboard unavailable');
      }
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        this.copyMessage = 'Copied — paste it anywhere to share the split.';
      } catch {
        this.copyMessage = 'Copy failed — use Download CSV instead.';
      }
      ta.remove();
    }
    this.render();
  }

  private downloadCsv(): void {
    const computed = computeAllocation(this.state);
    const csv = buildAllocationCsv(this.state, computed, (m) => this.formatAmount(m));
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'budget-allocation.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.copyMessage = 'CSV downloaded.';
    this.render();
    this.callbacks.onLogEvent?.('allocation.export_csv');
  }

  private downloadPng(): void {
    const computed = computeAllocation(this.state);
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1350;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, 1080, 1350);
    ctx.fillStyle = '#E8EEF2';
    ctx.font = '500 20px "JetBrains Mono", monospace';
    ctx.fillText('BUDGET ALLOCATION', 56, 62);
    ctx.fillStyle = '#6BE8F2';
    ctx.fillRect(48, 92, 984, 220);
    ctx.fillStyle = '#111111';
    ctx.font = '500 18px "JetBrains Mono", monospace';
    ctx.fillText('TOTAL BUDGET', 72, 140);
    ctx.font = '300 96px "Inter Tight", sans-serif';
    ctx.fillText(this.formatAmount(this.state.totalMinor), 72, 260);
    ctx.fillStyle = '#E8EEF2';
    ctx.font = '500 20px "JetBrains Mono", monospace';
    let y = 380;
    for (const row of computed.rows) {
      ctx.fillText(
        `${row.entry.name} — ${this.formatAmount(row.computedMinor)} (${row.percentOfTotal.toFixed(1)}%)`,
        56,
        y
      );
      y += 16;
      ctx.fillStyle = '#232A33';
      ctx.fillRect(56, y, 968, 14);
      ctx.fillStyle = computed.isOver ? '#E8799B' : '#6BE8F2';
      ctx.fillRect(56, y, Math.max(0, Math.min(968, (968 * row.percentOfTotal) / 100)), 14);
      ctx.fillStyle = '#E8EEF2';
      y += 56;
    }
    ctx.font = '500 20px "JetBrains Mono", monospace';
    ctx.fillText(`Allocated: ${this.formatAmount(computed.totalAllocatedMinor)}`, 56, y + 20);
    ctx.fillText(`Remaining: ${this.formatAmount(computed.remainingMinor)}`, 56, y + 52);
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'budget-allocation.png';
    a.click();
    this.copyMessage = 'PNG card downloaded.';
    this.render();
    this.callbacks.onLogEvent?.('allocation.export_png');
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
