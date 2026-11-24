import gsap from 'gsap';
import type { Day, Transaction } from '../../contracts/index.js';
import { formatMoneyMinor } from '../../contracts/index.js';
import {
  computeBudgetOverview,
  loadSavedBudgets,
  removeBudgetLimit,
  saveBudgetLimit,
  type BudgetOverviewSummary,
  type BudgetStatus,
  type BudgetStorageLike,
  type CategoryBudgetRow,
} from './budgets-engine.js';

export interface BudgetsOverlayCallbacks {
  onCloseBudgets: () => void;
  onOpenExplore: () => void;
  onOpenReceipts: (title: string, txnIds: string[]) => void;
  onLogEvent?: (type: string, value?: Record<string, unknown> | string | number) => void;
}

export class BudgetsOverlay {
  public readonly layerEl: HTMLElement;
  private readonly callbacks: BudgetsOverlayCallbacks;
  private readonly storageOverride?: BudgetStorageLike | null;

  private transactions: readonly Transaction[] = [];
  private days: readonly Day[] = [];
  private categoryLabels: Record<string, string> = {};
  private isB2B = false;
  private currencySymbol = '₦';

  private activeState = false;
  private selectedMonth: string | undefined = undefined;
  private savedBudgets: Record<string, number> = {};
  private editingKey: string | null = null;
  private editError: string | null = null;
  private draftValue = '';

  constructor(
    overParent: HTMLElement,
    callbacks: BudgetsOverlayCallbacks,
    storageOverride?: BudgetStorageLike | null
  ) {
    this.callbacks = callbacks;
    this.storageOverride = storageOverride;
    this.savedBudgets = loadSavedBudgets(this.storageOverride);

    this.layerEl = document.createElement('div');
    this.layerEl.className = 'ch ia';
    this.layerEl.id = 'o-budgets';
    this.layerEl.dataset.testid = 'budgets-overlay';
    this.layerEl.style.cssText =
      'position:absolute;inset:0;visibility:hidden;pointer-events:none;background:var(--ink, #111111);color:var(--bone, #F3F0E6);z-index:12;';
    overParent.appendChild(this.layerEl);
  }

  public setCurrencySymbol(currencySymbol: string): void {
    this.currencySymbol = currencySymbol || '₦';
    if (this.activeState) {
      this.render();
    }
  }

  public setDataset(
    days: readonly Day[],
    transactions: readonly Transaction[],
    categoryLabels?: Record<string, string>,
    isB2B = false,
    currencySymbol?: string
  ): void {
    this.days = days;
    this.transactions = transactions;
    this.categoryLabels = categoryLabels ? { ...categoryLabels } : {};
    this.isB2B = isB2B;
    this.currencySymbol = currencySymbol || this.currencySymbol || '₦';
    this.savedBudgets = loadSavedBudgets(this.storageOverride);
    this.selectedMonth = undefined;
    this.editingKey = null;
    this.editError = null;
    if (this.activeState) {
      this.render();
    }
  }

  public isActive(): boolean {
    return this.activeState;
  }

  public open(): void {
    this.activeState = true;
    this.savedBudgets = loadSavedBudgets(this.storageOverride);
    this.editingKey = null;
    this.editError = null;
    this.render();
    gsap.set(this.layerEl, { autoAlpha: 1 });
    this.layerEl.style.pointerEvents = 'auto';
    this.callbacks.onLogEvent?.('budgets.open', this.selectedMonth ?? 'latest');
  }

  public close(): void {
    if (!this.activeState) return;
    this.activeState = false;
    this.editingKey = null;
    this.editError = null;
    gsap.set(this.layerEl, { autoAlpha: 0 });
    this.layerEl.style.pointerEvents = 'none';
    this.callbacks.onLogEvent?.('budgets.close');
  }

  public getOverview(): BudgetOverviewSummary {
    return computeBudgetOverview({
      transactions: this.transactions,
      days: this.days,
      savedBudgets: this.savedBudgets,
      selectedMonth: this.selectedMonth,
      categoryLabels: this.categoryLabels,
      isB2B: this.isB2B,
    });
  }

  private formatAmount(amountMinor: number): string {
    const abs = Math.abs(Math.round(amountMinor));
    const showCents = abs % 100 !== 0;
    const formatted = formatMoneyMinor(abs, { showCents, prefix: '' });
    return `${amountMinor < 0 ? '-' : ''}${this.currencySymbol}${formatted}`;
  }

  private getStatusColors(status: BudgetStatus): {
    fg: string;
    barBg: string;
    border: string;
  } {
    switch (status) {
      case 'over_budget':
        return { fg: '#FF6B57', barBg: '#FF6B57', border: '#FF6B57' };
      case 'near_limit':
        return { fg: '#F4F03A', barBg: '#F4F03A', border: '#E3A83C' };
      case 'on_track':
        return { fg: '#B9F0C6', barBg: '#B9F0C6', border: '#3A3A38' };
      default:
        return { fg: '#8E8A7F', barBg: '#3A3A38', border: '#3A3A38' };
    }
  }

  private render(): void {
    const overview = this.getOverview();
    this.selectedMonth = overview.selectedMonth;

    const monthOptionsHtml = overview.availableMonths
      .map(
        (m) =>
          `<option value="${this.escapeHtml(m.value)}" ${m.value === overview.selectedMonth ? 'selected' : ''}>${this.escapeHtml(m.label)}</option>`
      )
      .join('');

    const paceNote = overview.isPartialMonth
      ? `Pace as of ${overview.asOfDateLabel} (Day ${overview.daysElapsed} of ${overview.daysInMonth})`
      : `Full month (${overview.daysInMonth} days)`;

    const totalBudgetStr =
      overview.configuredCount > 0 ? this.formatAmount(overview.totalBudgetMinor) : 'Not set';
    const totalSpentStr = this.formatAmount(overview.totalAllActualMinor);
    const totalRemainingStr =
      overview.configuredCount > 0 ? this.formatAmount(overview.totalRemainingMinor) : '—';
    const totalProjectedStr = this.formatAmount(overview.totalAllProjectedMinor);

    const remainingColor =
      overview.configuredCount === 0
        ? 'var(--bone)'
        : overview.totalRemainingMinor < 0
          ? '#FF6B57'
          : '#B9F0C6';

    const projectionSubtext =
      overview.configuredCount === 0
        ? 'Set a category budget to enable overrun alerts'
        : overview.projectedWarningCount > 0
          ? `${overview.projectedWarningCount} categor${overview.projectedWarningCount === 1 ? 'y' : 'ies'} projected over budget`
          : 'All budgeted categories projected within limit';

    const cardsHtml =
      overview.categories.length === 0
        ? `<div style="grid-column:1 / -1;padding:48px;border:1.5px solid #3A3A38;background:#161615;text-align:center;">
             <div style="font-size:24px;font-weight:400;margin-bottom:10px;">No expense categories found in this ledger.</div>
             <div class="lab" style="font-size:12px;color:#B8B4A9">Upload a ledger with outgoing expenses to set monthly budgets.</div>
           </div>`
        : overview.categories.map((row) => this.renderCategoryCardHtml(row)).join('');

    this.layerEl.innerHTML = `
      <div class="lab" style="position:absolute;left:64px;top:92px;">MONTHLY BUDGETS</div>
      <div class="lab" style="position:absolute;left:64px;top:122px;font-size:12px;color:#B8B4A9;">${this.escapeHtml(overview.selectedMonthLabel)} · ${this.escapeHtml(paceNote)} · Saved locally in your browser</div>

      <div style="position:absolute;right:64px;top:86px;display:flex;gap:10px;align-items:center;pointer-events:auto;">
        <select id="budgets-month-select" data-testid="budgets-month-select" aria-label="Select budget month" style="font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;padding:10px 14px;border:1.5px solid var(--bone);background:var(--ink);color:var(--bone);cursor:pointer;">
          ${monthOptionsHtml}
        </select>
        <button type="button" class="btn" id="budgets-explore-btn" data-testid="budgets-explore-btn" style="border-color:var(--bone);color:var(--bone)">Explore [E]</button>
        <button type="button" class="btn" id="budgets-receipts-btn" data-testid="budgets-receipts-btn" style="border-color:var(--bone);color:var(--bone)">Receipts</button>
        <button type="button" class="btn primary" id="budgets-close-btn" data-testid="budgets-close-btn" style="background:var(--c1);color:var(--ink);border-color:var(--c1)">← Back to story</button>
      </div>

      <div style="position:absolute;left:64px;right:64px;top:174px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;">
        <div data-testid="budgets-summary-total" style="background:var(--c1);color:var(--ink);padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;min-height:132px;">
          <div class="lab" style="font-size:11.5px;letter-spacing:0.12em;">TOTAL MONTHLY BUDGET</div>
          <div style="font-size:40px;font-weight:400;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1.05;">${this.escapeHtml(totalBudgetStr)}</div>
          <div class="lab" style="font-size:11px;opacity:0.85;">${overview.configuredCount} OF ${overview.categories.length} CATEGORIES SET</div>
        </div>

        <div data-testid="budgets-summary-spent" style="background:#161615;border:1.5px solid #3A3A38;color:var(--bone);padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;min-height:132px;">
          <div class="lab" style="font-size:11.5px;letter-spacing:0.12em;color:#B8B4A9;">ACTUAL SPENT (${this.escapeHtml(overview.selectedMonthLabel.toUpperCase())})</div>
          <div style="font-size:40px;font-weight:400;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1.05;">${this.escapeHtml(totalSpentStr)}</div>
          <div class="lab" style="font-size:11px;color:#B8B4A9;">${overview.configuredCount > 0 ? `${this.escapeHtml(this.formatAmount(overview.totalBudgetedActualMinor))} IN BUDGETED CATEGORIES` : 'NO BUDGET CAPS SET YET'}</div>
        </div>

        <div data-testid="budgets-summary-remaining" style="background:#161615;border:1.5px solid #3A3A38;color:var(--bone);padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;min-height:132px;">
          <div class="lab" style="font-size:11.5px;letter-spacing:0.12em;color:#B8B4A9;">REMAINING BUDGET</div>
          <div style="font-size:40px;font-weight:400;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1.05;color:${remainingColor};">${this.escapeHtml(totalRemainingStr)}</div>
          <div class="lab" style="font-size:11px;color:#B8B4A9;">${overview.overBudgetCount} OVER BUDGET · ${overview.nearLimitCount} NEAR LIMIT</div>
        </div>

        <div data-testid="budgets-summary-projected" style="background:#161615;border:1.5px solid ${overview.projectedWarningCount > 0 ? '#FF6B57' : '#3A3A38'};color:var(--bone);padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;min-height:132px;">
          <div class="lab" style="font-size:11.5px;letter-spacing:0.12em;color:#B8B4A9;">PROJECTED MONTH-END</div>
          <div style="font-size:40px;font-weight:400;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1.05;color:${overview.projectedWarningCount > 0 ? '#FFB58A' : 'var(--bone)'};">${this.escapeHtml(totalProjectedStr)}</div>
          <div class="lab" style="font-size:11px;color:${overview.projectedWarningCount > 0 ? '#FF6B57' : '#B8B4A9'};">${this.escapeHtml(projectionSubtext.toUpperCase())}</div>
        </div>
      </div>

      <div id="budgets-cards-grid" data-testid="budgets-cards-grid" style="position:absolute;left:64px;right:64px;top:330px;bottom:84px;overflow-y:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;align-content:start;padding-right:4px;padding-bottom:16px;">
        ${cardsHtml}
      </div>
    `;

    this.bindEvents();
  }

  private renderCategoryCardHtml(row: CategoryBudgetRow): string {
    const slug = row.budgetKey.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    const colors = this.getStatusColors(row.status);
    const isEditing = this.editingKey === row.budgetKey;

    const budgetStr = row.budgetMinor !== null ? this.formatAmount(row.budgetMinor) : 'Not set';
    const actualStr = this.formatAmount(row.actualMinor);
    const remainingStr = row.remainingMinor !== null ? this.formatAmount(row.remainingMinor) : '—';
    const projectedStr = this.formatAmount(row.projectedMinor);
    const pctStr = row.budgetMinor !== null ? `${Math.round(row.percentUsed)}%` : '—';

    const remainingColor =
      row.remainingMinor === null
        ? '#B8B4A9'
        : row.remainingMinor < 0
          ? '#FF6B57'
          : '#B9F0C6';

    const actionsHtml = isEditing
      ? ''
      : row.budgetMinor === null
        ? `<button type="button" data-action="edit-budget" data-budget-key="${this.escapeHtml(row.budgetKey)}" data-testid="budget-set-btn-${slug}" style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;padding:7px 12px;border:1.5px solid var(--c1);background:var(--c1);color:var(--ink);font-weight:600;white-space:nowrap;">Set budget</button>`
        : `<button type="button" data-action="edit-budget" data-budget-key="${this.escapeHtml(row.budgetKey)}" data-testid="budget-edit-btn-${slug}" style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;padding:7px 11px;border:1.5px solid var(--bone);color:var(--bone);white-space:nowrap;">Edit</button>
           <button type="button" data-action="remove-budget" data-budget-key="${this.escapeHtml(row.budgetKey)}" data-testid="budget-remove-btn-${slug}" style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;padding:7px 11px;border:1.5px solid #FF6B57;color:#FF6B57;white-space:nowrap;">Remove</button>`;

    const editFormHtml = isEditing
      ? `<div data-testid="budget-edit-form-${slug}" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;background:#111111;border:1.5px solid var(--c1);">
           <label for="budget-input-${slug}" class="lab" style="font-size:11px;color:var(--c1);white-space:nowrap;">Monthly limit (${this.escapeHtml(this.currencySymbol)})</label>
           <input
             id="budget-input-${slug}"
             type="number"
             min="1"
             step="any"
             data-budget-input="${this.escapeHtml(row.budgetKey)}"
             data-testid="budget-amount-input"
             value="${this.escapeHtml(this.draftValue)}"
             placeholder="e.g. 100000"
             style="flex:1;min-width:140px;padding:8px 12px;border:1.5px solid var(--bone);background:#1C1C1B;color:var(--bone);font-family:'JetBrains Mono',monospace;font-size:14px;outline:none;"
           />
           <button type="button" data-action="save-budget" data-budget-key="${this.escapeHtml(row.budgetKey)}" data-testid="budget-save-btn" style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;padding:9px 14px;background:var(--c1);color:var(--ink);border:1.5px solid var(--c1);font-weight:600;white-space:nowrap;">Save</button>
           <button type="button" data-action="cancel-budget" data-budget-key="${this.escapeHtml(row.budgetKey)}" data-testid="budget-cancel-btn" style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;padding:9px 12px;border:1.5px solid #8E8A7F;color:#B8B4A9;white-space:nowrap;">Cancel</button>
           ${this.editError ? `<div data-testid="budget-edit-error" style="flex-basis:100%;font-family:'JetBrains Mono',monospace;font-size:11px;color:#FF6B57;">${this.escapeHtml(this.editError)}</div>` : ''}
         </div>`
      : '';

    let warningHtml = '';
    if (row.projectedExceeds && row.budgetMinor !== null) {
      const excessStr = this.formatAmount(row.projectedExcessMinor);
      const overByStr =
        row.remainingMinor !== null && row.remainingMinor < 0
          ? this.formatAmount(Math.abs(row.remainingMinor))
          : '';
      const warningText =
        row.status === 'over_budget'
          ? `Warning: Over budget by ${overByStr} · projected month-end spend ${projectedStr} (+${excessStr} vs budget).`
          : `Warning: Projected month-end spend (${projectedStr}) will exceed budget by ${excessStr}.`;
      warningHtml = `
        <div data-testid="budget-projection-warning-${slug}" style="padding:10px 12px;border:1px solid #FF6B57;background:rgba(255,107,87,0.12);color:#FFB58A;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.4;">
          ${this.escapeHtml(warningText)}
        </div>
      `;
    }

    const receiptsLinkHtml =
      row.txnIds.length > 0
        ? `<button type="button" data-action="view-category-receipts" data-budget-key="${this.escapeHtml(row.budgetKey)}" style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#B8B4A9;text-decoration:underline;cursor:pointer;">Receipts</button>`
        : '';

    return `
      <article class="budget-card" data-budget-key="${this.escapeHtml(row.budgetKey)}" data-testid="budget-card-${slug}" style="background:#161615;border:1.5px solid ${colors.border};padding:22px 24px;display:flex;flex-direction:column;gap:14px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
          <div style="min-width:0;">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="width:12px;height:12px;background:${this.safeCssColor(row.color)};flex:none;"></span>
              <h3 style="font-size:24px;font-weight:500;letter-spacing:-0.02em;color:var(--bone);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this.escapeHtml(row.displayLabel)}</h3>
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-top:6px;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#B8B4A9;text-transform:uppercase;letter-spacing:0.06em;">
              <span>${row.txnCount} purchase${row.txnCount === 1 ? '' : 's'}</span>
              ${receiptsLinkHtml ? `<span aria-hidden="true">·</span>${receiptsLinkHtml}` : ''}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
            <span data-testid="budget-status-${slug}" style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;padding:6px 10px;border:1px solid ${colors.fg};color:${colors.fg};white-space:nowrap;">${this.escapeHtml(row.statusLabel)}</span>
            ${actionsHtml}
          </div>
        </div>

        ${editFormHtml}

        <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding-top:2px;">
          <div>
            <div class="lab" style="font-size:10.5px;color:#8E8A7F;">BUDGET</div>
            <div data-testid="budget-limit-${slug}" style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:500;margin-top:4px;font-variant-numeric:tabular-nums;">${this.escapeHtml(budgetStr)}</div>
          </div>
          <div>
            <div class="lab" style="font-size:10.5px;color:#8E8A7F;">ACTUAL SPENT</div>
            <div data-testid="budget-actual-${slug}" style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:500;margin-top:4px;font-variant-numeric:tabular-nums;">${this.escapeHtml(actualStr)}</div>
          </div>
          <div>
            <div class="lab" style="font-size:10.5px;color:#8E8A7F;">REMAINING</div>
            <div data-testid="budget-remaining-${slug}" style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:500;margin-top:4px;font-variant-numeric:tabular-nums;color:${remainingColor};">${this.escapeHtml(remainingStr)}</div>
          </div>
          <div>
            <div class="lab" style="font-size:10.5px;color:#8E8A7F;">PROJECTED MONTH-END</div>
            <div data-testid="budget-projected-${slug}" style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:500;margin-top:4px;font-variant-numeric:tabular-nums;color:${row.projectedExceeds ? '#FFB58A' : 'var(--bone)'};">${this.escapeHtml(projectedStr)}</div>
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:12px;">
          <div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.round(row.percentUsed))}" style="flex:1;height:11px;background:#262625;border:1px solid #3A3A38;overflow:hidden;">
            <div data-testid="budget-progress-fill-${slug}" style="width:${row.progressWidthPct.toFixed(1)}%;height:100%;background:${colors.barBg};transition:width 0.2s ease;"></div>
          </div>
          <span data-testid="budget-percent-${slug}" style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;min-width:44px;text-align:right;font-variant-numeric:tabular-nums;color:${colors.fg};">${this.escapeHtml(pctStr)}</span>
        </div>

        ${warningHtml}
      </article>
    `;
  }

  private bindEvents(): void {
    this.layerEl.querySelector('#budgets-close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onCloseBudgets();
    });

    this.layerEl.querySelector('#budgets-explore-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onOpenExplore();
    });

    this.layerEl.querySelector('#budgets-receipts-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const overview = this.getOverview();
      const allMonthIds = overview.categories.flatMap((c) => c.txnIds);
      this.callbacks.onOpenReceipts(`${overview.selectedMonthLabel} Expenses`, allMonthIds);
    });

    const monthSelect = this.layerEl.querySelector<HTMLSelectElement>('#budgets-month-select');
    monthSelect?.addEventListener('change', () => {
      this.selectedMonth = monthSelect.value;
      this.editingKey = null;
      this.editError = null;
      this.render();
      this.callbacks.onLogEvent?.('budgets.month', this.selectedMonth);
    });

    this.layerEl.querySelectorAll<HTMLButtonElement>('[data-action="edit-budget"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.budgetKey;
        if (!key) return;
        const currentMinor = this.savedBudgets[key];
        this.editingKey = key;
        this.editError = null;
        this.draftValue = currentMinor ? String(currentMinor / 100) : '';
        this.render();
        const input = this.layerEl.querySelector<HTMLInputElement>('[data-budget-input]');
        input?.focus();
      });
    });

    this.layerEl
      .querySelectorAll<HTMLButtonElement>('[data-action="remove-budget"]')
      .forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const key = btn.dataset.budgetKey;
          if (!key) return;
          this.savedBudgets = removeBudgetLimit(key, this.storageOverride);
          if (this.editingKey === key) {
            this.editingKey = null;
            this.editError = null;
          }
          this.render();
          this.callbacks.onLogEvent?.('budgets.remove', { key });
        });
      });

    this.layerEl
      .querySelectorAll<HTMLButtonElement>('[data-action="cancel-budget"]')
      .forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.editingKey = null;
          this.editError = null;
          this.render();
        });
      });

    this.layerEl.querySelectorAll<HTMLButtonElement>('[data-action="save-budget"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.budgetKey;
        if (key) {
          this.commitBudgetEdit(key);
        }
      });
    });

    this.layerEl
      .querySelectorAll<HTMLButtonElement>('[data-action="view-category-receipts"]')
      .forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const key = btn.dataset.budgetKey;
          if (!key) return;
          const overview = this.getOverview();
          const row = overview.categories.find((c) => c.budgetKey === key);
          if (row) {
            this.callbacks.onOpenReceipts(
              `${row.displayLabel} · ${overview.selectedMonthLabel}`,
              row.txnIds
            );
          }
        });
      });

    const inputEl = this.layerEl.querySelector<HTMLInputElement>('[data-budget-input]');
    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.editingKey) {
        e.preventDefault();
        e.stopPropagation();
        this.commitBudgetEdit(this.editingKey);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.editingKey = null;
        this.editError = null;
        this.render();
      }
    });
  }

  private commitBudgetEdit(budgetKey: string): void {
    const inputEl = this.layerEl.querySelector<HTMLInputElement>('[data-budget-input]');
    const rawStr = (inputEl?.value ?? this.draftValue).replace(/[\s,]/g, '');
    const parsed = Number(rawStr);
    if (!rawStr || !Number.isFinite(parsed) || parsed <= 0) {
      this.draftValue = inputEl?.value ?? '';
      this.editError = 'Enter a monthly amount greater than 0.';
      this.render();
      this.layerEl.querySelector<HTMLInputElement>('[data-budget-input]')?.focus();
      return;
    }

    const minor = Math.round(parsed * 100);
    this.savedBudgets = saveBudgetLimit(budgetKey, minor, this.storageOverride);
    this.editingKey = null;
    this.editError = null;
    this.render();
    this.callbacks.onLogEvent?.('budgets.save', { key: budgetKey, amount_minor: minor });
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private safeCssColor(val: string): string {
    const s = val.trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(s) || /^var\(--[A-Za-z0-9_-]+\)$/.test(s)) return s;
    return '#F4F03A';
  }
}
