import gsap from 'gsap';
import type { DatasetBundle, Day, Transaction } from '../../contracts/index.js';
import { formatMoneyMinor } from '../../contracts/index.js';
import { processByoIngestion, readBrowserFiles } from '../ingest/index.js';
import type { BudgetStorageLike } from '../budgets/budgets-engine.js';
import {
  clearYearComparison,
  compareYearSummaries,
  computeYearSummary,
  loadSavedYearComparison,
  saveYearComparison,
  type YearComparison,
  type YearSummary,
} from './year-comparison-engine.js';

export interface YearComparisonOverlayCallbacks {
  onCloseCompare: () => void;
  onOpenExplore: () => void;
  onOpenBudgets: () => void;
  onLoadDataset: (bundle: DatasetBundle) => void;
  onLogEvent?: (type: string, value?: Record<string, unknown> | string | number) => void;
}

export class YearComparisonOverlay {
  public readonly layerEl: HTMLElement;
  private readonly callbacks: YearComparisonOverlayCallbacks;
  private readonly storageOverride?: BudgetStorageLike | null;

  private transactions: readonly Transaction[] = [];
  private days: readonly Day[] = [];
  private currencySymbol = '₦';
  private activeState = false;
  private previousSummary: YearSummary | null = null;
  private loadingMessage: string | null = null;
  private loadError: string | null = null;
  private busy = false;

  constructor(
    overParent: HTMLElement,
    callbacks: YearComparisonOverlayCallbacks,
    storageOverride?: BudgetStorageLike | null
  ) {
    this.callbacks = callbacks;
    this.storageOverride = storageOverride;
    this.previousSummary = loadSavedYearComparison(this.storageOverride);

    this.layerEl = document.createElement('div');
    this.layerEl.className = 'ch ia';
    this.layerEl.id = 'o-compare';
    this.layerEl.dataset.testid = 'compare-overlay';
    this.layerEl.style.cssText =
      'position:absolute;inset:0;visibility:hidden;pointer-events:none;background:var(--ink, #111111);color:var(--bone, #E8EEF2);z-index:12;';
    overParent.appendChild(this.layerEl);
  }

  public setCurrencySymbol(currencySymbol: string): void {
    this.currencySymbol = currencySymbol || '₦';
    if (this.activeState) this.render();
  }

  public setDataset(
    days: readonly Day[],
    transactions: readonly Transaction[],
    _categoryLabels?: Record<string, string>,
    _isB2B = false,
    currencySymbol?: string
  ): void {
    this.days = days;
    this.transactions = transactions;
    this.currencySymbol = currencySymbol || this.currencySymbol || '₦';
    if (this.activeState) this.render();
  }

  public isActive(): boolean {
    return this.activeState;
  }

  public open(): void {
    this.activeState = true;
    this.loadError = null;
    this.loadingMessage = null;
    this.render();
    gsap.set(this.layerEl, { autoAlpha: 1 });
    this.layerEl.style.pointerEvents = 'auto';
    this.callbacks.onLogEvent?.('compare.open');
  }

  public close(): void {
    if (!this.activeState) return;
    this.activeState = false;
    gsap.set(this.layerEl, { autoAlpha: 0 });
    this.layerEl.style.pointerEvents = 'none';
    this.callbacks.onLogEvent?.('compare.close');
  }

  public getComparison(): YearComparison | null {
    const current = computeYearSummary(this.transactions);
    if (!current || !this.previousSummary) return null;
    return compareYearSummaries(current, this.previousSummary, (m) => this.formatAmount(m));
  }

  private formatAmount(amountMinor: number): string {
    const abs = Math.abs(Math.round(amountMinor));
    const showCents = abs % 100 !== 0;
    const formatted = formatMoneyMinor(abs, { showCents, prefix: '' });
    return `${amountMinor < 0 ? '-' : ''}${this.currencySymbol}${formatted}`;
  }

  private formatPct(pct: number | null): string {
    if (pct === null) return '—';
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  }

  private render(): void {
    const current = computeYearSummary(this.transactions);
    const comparison = this.getComparison();

    const currentLabel = current ? current.label : '—';
    const previousLabel = this.previousSummary ? this.previousSummary.label : '—';

    const summaryCards = comparison
      ? `
      <div style="position:absolute;left:64px;right:64px;top:174px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;">
        ${this.renderTotalCard(`THIS YEAR (${this.escapeHtml(currentLabel)})`, comparison.current, true)}
        ${this.renderTotalCard(`LAST YEAR (${this.escapeHtml(previousLabel)})`, comparison.previous, false)}
        <div data-testid="compare-change-card" style="background:#131A21;border:1.5px solid ${comparison.netImproved ? '#B9F0C6' : '#E8799B'};color:var(--bone);padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;gap:10px;min-height:148px;">
          <div class="lab" style="font-size:14px;letter-spacing:0.12em;color:#AEBAC7;">CHANGE VS LAST YEAR</div>
          <div style="font-size:40px;font-weight:400;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1.05;color:${comparison.netImproved ? '#B9F0C6' : '#E8799B'};">${comparison.netDeltaMinor >= 0 ? '+' : ''}${this.escapeHtml(this.formatAmount(comparison.netDeltaMinor))}</div>
          <div class="lab" style="font-size:14px;color:#AEBAC7;">INCOME ${this.escapeHtml(this.formatPct(comparison.incomeDeltaPct))} · EXPENSES ${this.escapeHtml(this.formatPct(comparison.expenseDeltaPct))}</div>
        </div>
      </div>`
      : '';

    const tableHtml = comparison
      ? `
      <div style="position:absolute;left:64px;right:64px;top:${comparison ? 330 : 330}px;bottom:84px;overflow-y:auto;">
        <div class="lab" style="font-size:15px;color:#AEBAC7;margin-bottom:12px;">${this.escapeHtml(comparison.summaryText)}</div>
        <table data-testid="compare-table" style="width:100%;border-collapse:collapse;font-family:'JetBrains Mono',monospace;font-size:13px;">
          <thead>
            <tr style="text-align:left;color:#AEBAC7;text-transform:uppercase;font-size:14px;letter-spacing:0.08em;">
              <th style="padding:10px 12px;border-bottom:1.5px solid #3A4552;">Category</th>
              <th style="padding:10px 12px;border-bottom:1.5px solid #3A4552;text-align:right;">${this.escapeHtml(currentLabel)} spend</th>
              <th style="padding:10px 12px;border-bottom:1.5px solid #3A4552;text-align:right;">${this.escapeHtml(previousLabel)} spend</th>
              <th style="padding:10px 12px;border-bottom:1.5px solid #3A4552;text-align:right;">Change</th>
              <th style="padding:10px 12px;border-bottom:1.5px solid #3A4552;text-align:right;">%</th>
            </tr>
          </thead>
          <tbody>
            ${comparison.categoryRows
              .map(
                (row) => `
              <tr data-testid="compare-row-${this.escapeHtml(row.key.replace(/[^a-z0-9]+/gi, '-'))}">
                <td style="padding:10px 12px;border-bottom:1px solid #232A33;">${this.escapeHtml(row.label)}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #232A33;text-align:right;">${this.escapeHtml(this.formatAmount(row.currentExpenseMinor))}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #232A33;text-align:right;">${this.escapeHtml(this.formatAmount(row.previousExpenseMinor))}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #232A33;text-align:right;color:${row.expenseDeltaMinor > 0 ? '#E8799B' : row.expenseDeltaMinor < 0 ? '#B9F0C6' : 'var(--bone)'};">${row.expenseDeltaMinor >= 0 ? '+' : ''}${this.escapeHtml(this.formatAmount(row.expenseDeltaMinor))}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #232A33;text-align:right;">${this.escapeHtml(this.formatPct(row.expenseDeltaPct))}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
        <div style="margin-top:18px;">
          <div class="lab" style="font-size:14px;color:#AEBAC7;margin-bottom:10px;">SPENDING BY CATEGORY — ${this.escapeHtml(currentLabel)} VS ${this.escapeHtml(previousLabel)}</div>
          ${comparison.categoryRows.map((row) => this.renderCategoryBars(row)).join('')}
        </div>
      </div>`
      : `
      <div style="position:absolute;left:64px;right:64px;top:330px;bottom:84px;overflow-y:auto;">
        <div style="padding:48px;border:1.5px solid #3A4552;background:#131A21;text-align:center;">
          <div style="font-size:24px;font-weight:400;margin-bottom:10px;">No last-year file loaded yet.</div>
          <div class="lab" style="font-size:15px;color:#AEBAC7">Load a ledger from last year to compare it with ${this.escapeHtml(currentLabel)} — the file is parsed locally in your browser and never uploaded.</div>
        </div>
      </div>`;

    this.layerEl.innerHTML = `
      <div class="lab" style="position:absolute;left:64px;top:92px;">THIS YEAR VS LAST YEAR</div>
      <div class="lab" style="position:absolute;left:64px;top:122px;font-size:15px;color:#AEBAC7;">${current ? `${this.escapeHtml(current.txnCount.toString())} TRANSACTIONS IN ${this.escapeHtml(currentLabel)}` : 'LOAD A LEDGER TO COMPARE YEARS'} · SAVED LOCALLY IN YOUR BROWSER</div>

      <div style="position:absolute;right:64px;top:86px;display:flex;gap:10px;align-items:center;pointer-events:auto;flex-wrap:wrap;justify-content:flex-end;">
        <button type="button" class="btn" id="compare-load-current-btn" data-testid="compare-load-current-btn" style="border-color:var(--bone);color:var(--bone)">Load this-year file</button>
        <button type="button" class="btn primary" id="compare-load-previous-btn" data-testid="compare-load-previous-btn" style="background:var(--c1);color:var(--ink);border-color:var(--c1)" ${this.busy ? 'disabled' : ''}>Load last-year file</button>
        ${this.previousSummary ? `<button type="button" class="btn" id="compare-clear-btn" data-testid="compare-clear-btn" style="border-color:#E8799B;color:#E8799B">Clear last year</button>` : ''}
        <button type="button" class="btn" id="compare-budgets-btn" data-testid="compare-budgets-btn" style="border-color:var(--bone);color:var(--bone)">Budgets [B]</button>
        <button type="button" class="btn" id="compare-close-btn" data-testid="compare-close-btn" style="border-color:var(--bone);color:var(--bone)">← Back to story</button>
      </div>

      <input type="file" id="compare-file-input" data-testid="compare-file-input" accept=".xlsx,.xls,.csv,.json,.pdf,.tsv,.txt" style="display:none" />
      <input type="file" id="compare-current-file-input" data-testid="compare-current-file-input" accept=".xlsx,.xls,.csv,.json,.pdf,.tsv,.txt" style="display:none" />

      ${this.loadingMessage ? `<div data-testid="compare-loading" style="position:absolute;left:64px;right:64px;top:150px;font-family:'JetBrains Mono',monospace;font-size:15px;color:var(--c1);">${this.escapeHtml(this.loadingMessage)}</div>` : ''}
      ${this.loadError ? `<div data-testid="compare-error" style="position:absolute;left:64px;right:64px;top:150px;font-family:'JetBrains Mono',monospace;font-size:15px;color:#E8799B;">${this.escapeHtml(this.loadError)}</div>` : ''}

      ${summaryCards}
      ${tableHtml}
    `;

    this.bindEvents();
  }

  private renderTotalCard(title: string, summary: YearSummary, isCurrent: boolean): string {
    const accent = isCurrent ? 'var(--c1)' : '#131A21';
    const fg = isCurrent ? 'var(--ink)' : 'var(--bone)';
    const border = isCurrent ? 'var(--c1)' : '#3A4552';
    return `
      <div data-testid="compare-total-${isCurrent ? 'current' : 'previous'}" style="background:${accent};border:1.5px solid ${border};color:${fg};padding:20px 24px;display:flex;flex-direction:column;justify-content:space-between;gap:10px;min-height:148px;">
        <div class="lab" style="font-size:14px;letter-spacing:0.12em;${isCurrent ? '' : 'color:#AEBAC7;'}">${this.escapeHtml(title)}</div>
        <div style="font-size:40px;font-weight:400;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1.05;">${this.escapeHtml(this.formatAmount(summary.netMinor))} net</div>
        <div class="lab" style="font-size:14px;${isCurrent ? 'opacity:0.85;' : 'color:#AEBAC7;'}">${this.escapeHtml(this.formatAmount(summary.incomeMinor))} IN · ${this.escapeHtml(this.formatAmount(summary.expenseMinor))} OUT · ${summary.txnCount} TXNS</div>
      </div>`;
  }

  private renderCategoryBars(row: {
    label: string;
    currentExpenseMinor: number;
    previousExpenseMinor: number;
  }): string {
    const max = Math.max(row.currentExpenseMinor, row.previousExpenseMinor, 1);
    const curPct = (row.currentExpenseMinor / max) * 100;
    const prevPct = (row.previousExpenseMinor / max) * 100;
    return `
      <div style="margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:14px;color:#AEBAC7;margin-bottom:4px;">
          <span>${this.escapeHtml(row.label)}</span>
          <span>${this.escapeHtml(this.formatAmount(row.currentExpenseMinor))} vs ${this.escapeHtml(this.formatAmount(row.previousExpenseMinor))}</span>
        </div>
        <div style="height:10px;background:#232A33;margin-bottom:3px;"><div style="width:${curPct.toFixed(1)}%;height:100%;background:var(--c1);"></div></div>
        <div style="height:10px;background:#232A33;"><div style="width:${prevPct.toFixed(1)}%;height:100%;background:#8A99A8;"></div></div>
      </div>`;
  }

  private bindEvents(): void {
    this.layerEl.querySelector('#compare-close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onCloseCompare();
    });
    this.layerEl.querySelector('#compare-budgets-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onOpenBudgets();
    });
    this.layerEl.querySelector('#compare-clear-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      clearYearComparison(this.storageOverride);
      this.previousSummary = null;
      this.render();
      this.callbacks.onLogEvent?.('compare.clear');
    });

    const prevInput = this.layerEl.querySelector<HTMLInputElement>('#compare-file-input');
    this.layerEl.querySelector('#compare-load-previous-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      prevInput?.click();
    });
    prevInput?.addEventListener('change', () => {
      if (prevInput.files && prevInput.files.length > 0) {
        void this.loadPreviousYearFile(prevInput.files);
      }
      prevInput.value = '';
    });

    const curInput = this.layerEl.querySelector<HTMLInputElement>('#compare-current-file-input');
    this.layerEl.querySelector('#compare-load-current-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      curInput?.click();
    });
    curInput?.addEventListener('change', () => {
      if (curInput.files && curInput.files.length > 0) {
        void this.loadCurrentYearFile(curInput.files);
      }
      curInput.value = '';
    });
  }

  private async loadPreviousYearFile(fileList: FileList | File[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.loadError = null;
    this.loadingMessage = 'Parsing last-year file locally…';
    this.render();
    try {
      const files = await readBrowserFiles(fileList);
      const bundle = await processByoIngestion({ files });
      const summary = computeYearSummary(bundle.transactions, files[0]?.name ?? '');
      if (!summary) {
        throw new Error('No dated transactions found in that file.');
      }
      const current = computeYearSummary(this.transactions);
      if (current && summary.year === current.year) {
        this.loadError = `That file is also from ${summary.year}. Load a file from a different year to compare.`;
        this.loadingMessage = null;
        this.busy = false;
        this.render();
        return;
      }
      this.previousSummary = summary;
      saveYearComparison(summary, this.storageOverride);
      this.loadingMessage = null;
      this.busy = false;
      this.render();
      this.callbacks.onLogEvent?.('compare.load_previous', { year: summary.year });
    } catch (err) {
      this.loadingMessage = null;
      this.busy = false;
      this.loadError =
        err instanceof Error
          ? err.message
          : 'Could not parse that file. Try an Excel, CSV, JSON or PDF ledger.';
      this.render();
    }
  }

  private async loadCurrentYearFile(fileList: FileList | File[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.loadError = null;
    this.loadingMessage = 'Parsing this-year file locally…';
    this.render();
    try {
      const files = await readBrowserFiles(fileList);
      const bundle = await processByoIngestion({ files });
      this.busy = false;
      this.loadingMessage = null;
      this.callbacks.onLoadDataset(bundle);
      this.callbacks.onLogEvent?.('compare.load_current');
    } catch (err) {
      this.loadingMessage = null;
      this.busy = false;
      this.loadError =
        err instanceof Error
          ? err.message
          : 'Could not parse that file. Try an Excel, CSV, JSON or PDF ledger.';
      this.render();
    }
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
