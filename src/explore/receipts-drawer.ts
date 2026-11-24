import gsap from 'gsap';
import type { Transaction } from '../../contracts/index.js';
import { formatMoneyMinor } from '../../contracts/index.js';
import { stripCurrencyPrefix } from '../currency/index.js';
import { CATEGORY_COLORS } from '../grid/interactive-grid.js';

export interface ReceiptsSummary {
  transactions: Transaction[];
  count: number;
  inCount: number;
  outCount: number;
  totalOutMinor: number;
  totalInMinor: number;
  netMinor: number;
  formattedTotalOut: string;
  formattedTotalIn: string;
  formattedNetAbs: string;
}

/**
 * Pure deterministic filter returning transactions matching `txnIds` in deterministic order.
 */
export function filterTransactionsByIds(
  allTransactions: readonly Transaction[],
  txnIds: readonly string[]
): Transaction[] {
  if (txnIds.length === 0) return [];
  const byId = new Map<string, Transaction>();
  for (const t of allTransactions) {
    byId.set(t.id, t);
  }
  const seen = new Set<string>();
  const matched: Transaction[] = [];
  for (const id of txnIds) {
    if (seen.has(id)) continue;
    const t = byId.get(id);
    if (t) {
      seen.add(id);
      matched.push(t);
    }
  }
  return matched;
}

/**
 * Pure deterministic summary of a receipt transaction list.
 */
export function summarizeReceipts(transactions: readonly Transaction[]): ReceiptsSummary {
  let totalOutMinor = 0;
  let totalInMinor = 0;
  let outCount = 0;
  let inCount = 0;
  for (const t of transactions) {
    if (t.direction === 'out') {
      totalOutMinor += t.amount_minor;
      outCount++;
    } else {
      totalInMinor += t.amount_minor;
      inCount++;
    }
  }
  const netMinor = totalInMinor - totalOutMinor;
  return {
    transactions: [...transactions],
    count: transactions.length,
    inCount,
    outCount,
    totalOutMinor,
    totalInMinor,
    netMinor,
    formattedTotalOut: formatMoneyMinor(totalOutMinor, { showCents: true }),
    formattedTotalIn: formatMoneyMinor(totalInMinor, { showCents: true }),
    formattedNetAbs: formatMoneyMinor(Math.abs(netMinor), { showCents: true }),
  };
}

export class ReceiptsDrawer {
  public readonly backdropEl: HTMLElement;
  public readonly drawerEl: HTMLElement;
  private allTransactions: readonly Transaction[];
  public currencySymbol = '₦';
  private currentTitle = '';
  private currentTxns: Transaction[] = [];
  private sortMode: 'date' | 'amount' = 'amount';
  private searchQuery = '';
  private openState = false;
  public reducedMotion = false;
  private readonly onLogEvent?: (
    type: string,
    value?: Record<string, unknown> | string | number
  ) => void;

  constructor(
    parentContainer: HTMLElement,
    allTransactions: readonly Transaction[],
    onLogEvent?: (type: string, value?: Record<string, unknown> | string | number) => void
  ) {
    this.allTransactions = allTransactions;
    this.onLogEvent = onLogEvent;

    this.backdropEl = document.createElement('div');
    this.backdropEl.id = 'receipts-backdrop';
    this.backdropEl.dataset.testid = 'receipts-backdrop';
    this.backdropEl.style.cssText =
      'position:fixed;inset:0;background:rgba(17,17,17,0.62);z-index:80;visibility:hidden;opacity:0;display:flex;justify-content:flex-end;';

    this.drawerEl = document.createElement('aside');
    this.drawerEl.id = 'receipts-drawer';
    this.drawerEl.dataset.testid = 'receipts-drawer';
    this.drawerEl.setAttribute('role', 'dialog');
    this.drawerEl.setAttribute('aria-label', 'Traceable Receipts');
    this.drawerEl.style.cssText =
      'width:min(540px, 100vw);height:100%;background:var(--bone, #E8EEF2);color:var(--ink, #111111);border-left:2px solid var(--ink, #111111);display:flex;flex-direction:column;transform:translateX(100%);font-family:"Inter Tight",system-ui,sans-serif;';

    this.backdropEl.appendChild(this.drawerEl);
    parentContainer.appendChild(this.backdropEl);

    this.backdropEl.addEventListener('click', (e) => {
      if (e.target === this.backdropEl) {
        this.close();
      }
    });
  }

  public setCurrencySymbol(currencySymbol: string): void {
    this.currencySymbol = currencySymbol || '₦';
    if (this.openState) {
      this.render();
    }
  }

  public setTransactions(transactions: readonly Transaction[], currencySymbol?: string): void {
    this.allTransactions = transactions;
    this.currencySymbol = currencySymbol ?? this.currencySymbol ?? '₦';
    if (this.openState) {
      this.currentTxns = filterTransactionsByIds(
        this.allTransactions,
        this.currentTxns.map((t) => t.id)
      );
      this.render();
    }
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public open(title: string, txnIds: readonly string[]): void {
    this.currentTitle = title;
    this.currentTxns = filterTransactionsByIds(this.allTransactions, txnIds);
    this.searchQuery = '';
    this.openState = true;
    this.render();

    gsap.killTweensOf([this.backdropEl, this.drawerEl]);
    if (this.reducedMotion) {
      gsap.set(this.backdropEl, { autoAlpha: 1 });
      gsap.set(this.drawerEl, { xPercent: 0, x: 0 });
    } else {
      gsap.to(this.backdropEl, { autoAlpha: 1, duration: 0.2, ease: 'power2.out' });
      gsap.fromTo(this.drawerEl, { x: '100%' }, { x: '0%', duration: 0.36, ease: 'power3.out' });
    }

    this.onLogEvent?.('receipts.open', {
      title,
      count: this.currentTxns.length,
    });
  }

  public close(): void {
    if (!this.openState) return;
    this.openState = false;
    gsap.killTweensOf([this.backdropEl, this.drawerEl]);
    if (this.reducedMotion) {
      gsap.set(this.backdropEl, { autoAlpha: 0 });
    } else {
      gsap.to(this.drawerEl, { x: '100%', duration: 0.26, ease: 'power3.in' });
      gsap.to(this.backdropEl, { autoAlpha: 0, duration: 0.26, ease: 'power2.in' });
    }
    this.onLogEvent?.('receipts.close', this.currentTitle);
  }

  private render(): void {
    this.drawerEl.innerHTML = `
      <div style="padding:24px 28px 18px;border-bottom:2px solid #111;background:#6BE8F2;color:#111">
        <div style="display:flex;justify-content:space-between;align-items:center;font-family:'JetBrains Mono',monospace;font-size:14px;letter-spacing:0.12em;text-transform:uppercase;">
          <span>Ledger entries · click any row</span>
          <button type="button" data-action="close-receipts" data-testid="close-receipts-btn" style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600;padding:6px 12px;border:1.5px solid #111;background:#111;color:#E8EEF2;cursor:pointer;">CLOSE [ESC]</button>
        </div>
        <h2 style="font-size:32px;font-weight:400;letter-spacing:-0.03em;line-height:1.1;margin-top:12px">${this.escapeHtml(this.currentTitle)}</h2>
        <div id="receipts-summary-bar" style="margin-top:14px;font-family:'JetBrains Mono',monospace;"></div>
      </div>
      <div style="padding:14px 28px;border-bottom:1.5px solid #111;display:flex;gap:10px;align-items:center;background:#DDE6EE">
        <input type="search" id="receipts-search" placeholder="Filter merchant, category, date, ID…" value="${this.escapeHtml(this.searchQuery)}" style="flex:1;padding:8px 12px;border:1.5px solid #111;background:#E8EEF2;font-family:'JetBrains Mono',monospace;font-size:15px;color:#111;outline:none;" />
        <button type="button" data-sort="amount" style="font-family:'JetBrains Mono',monospace;font-size:14px;text-transform:uppercase;padding:8px 11px;border:1.5px solid #111;background:${this.sortMode === 'amount' ? '#111' : 'transparent'};color:${this.sortMode === 'amount' ? '#E8EEF2' : '#111'};cursor:pointer;">Amount ↓</button>
        <button type="button" data-sort="date" style="font-family:'JetBrains Mono',monospace;font-size:14px;text-transform:uppercase;padding:8px 11px;border:1.5px solid #111;background:${this.sortMode === 'date' ? '#111' : 'transparent'};color:${this.sortMode === 'date' ? '#E8EEF2' : '#111'};cursor:pointer;">Date ↓</button>
      </div>
      <div id="receipts-list" data-testid="receipts-list" style="flex:1;overflow-y:auto;padding:12px 28px 28px"></div>
    `;

    const closeBtn = this.drawerEl.querySelector('[data-action="close-receipts"]');
    closeBtn?.addEventListener('click', () => this.close());

    const searchInput = this.drawerEl.querySelector<HTMLInputElement>('#receipts-search');
    searchInput?.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      this.renderListOnly();
    });

    const sortBtns = this.drawerEl.querySelectorAll<HTMLButtonElement>('[data-sort]');
    sortBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.sortMode = (btn.dataset.sort as 'date' | 'amount') || 'amount';
        this.render();
      });
    });

    this.renderListOnly();
  }

  private updateSummaryBar(filtered: readonly Transaction[], totalCount: number): boolean {
    const summary = summarizeReceipts(filtered);
    const outAmount = stripCurrencyPrefix(summary.formattedTotalOut);
    const inAmount = stripCurrencyPrefix(summary.formattedTotalIn);
    const netAbsAmount = stripCurrencyPrefix(summary.formattedNetAbs);
    const isMixed = summary.inCount > 0 && summary.outCount > 0;
    const isInflowOnly = summary.inCount > 0 && summary.outCount === 0;

    let primaryTotalStr: string;
    if (isMixed) {
      const netSign = summary.netMinor >= 0 ? '+' : '-';
      primaryTotalStr = `NET ${netSign}${this.currencySymbol}${netAbsAmount}`;
    } else if (isInflowOnly) {
      primaryTotalStr = `+${this.currencySymbol}${inAmount}`;
    } else {
      primaryTotalStr = `${this.currencySymbol}${outAmount}`;
    }

    const isFiltered = filtered.length < totalCount;
    const countPart = isFiltered
      ? `<b>${summary.count} OF ${totalCount}</b> TRANSACTION${totalCount === 1 ? '' : 'S'}`
      : `<b>${summary.count}</b> TRANSACTION${summary.count === 1 ? '' : 'S'}`;

    const scopeSuffix = isMixed
      ? ` (${summary.inCount} IN · ${summary.outCount} OUT)`
      : isInflowOnly
        ? ' · INFLOWS'
        : summary.outCount > 0
          ? ' · OUTFLOWS'
          : '';

    const breakdownHtml = isMixed
      ? `<div style="display:flex;justify-content:flex-end;gap:14px;margin-top:6px;font-size:14px;letter-spacing:0.04em;opacity:0.85">
           <span>+${this.escapeHtml(this.currencySymbol)}${inAmount} IN</span>
           <span>-${this.escapeHtml(this.currencySymbol)}${outAmount} OUT</span>
         </div>`
      : '';

    const summaryBar = this.drawerEl.querySelector<HTMLElement>('#receipts-summary-bar');
    if (summaryBar) {
      summaryBar.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:13px;">
          <span>${countPart}${scopeSuffix}</span>
          <span style="font-size:20px;font-weight:600;white-space:nowrap">${this.escapeHtml(primaryTotalStr)}</span>
        </div>
        ${breakdownHtml}
      `;
    }
    return isMixed;
  }

  private renderListOnly(): void {
    const listEl = this.drawerEl.querySelector<HTMLElement>('#receipts-list');
    if (!listEl) return;

    const q = this.searchQuery.trim().toLowerCase();
    const filtered = this.currentTxns.filter((t) => {
      if (!q) return true;
      return (
        t.merchant.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q) ||
        (t.category_label?.toLowerCase().includes(q) ?? false) ||
        t.date.includes(q) ||
        t.id.toLowerCase().includes(q)
      );
    });

    filtered.sort((a, b) => {
      if (this.sortMode === 'amount') {
        return b.amount_minor - a.amount_minor || a.date.localeCompare(b.date);
      }
      return b.date.localeCompare(a.date) || b.amount_minor - a.amount_minor;
    });

    const isMixed = this.updateSummaryBar(filtered, this.currentTxns.length);

    if (filtered.length === 0) {
      listEl.innerHTML = `<div style="padding:32px 0;font-family:'JetBrains Mono',monospace;font-size:13px;opacity:0.65;text-align:center">No matching transactions.</div>`;
      return;
    }

    listEl.innerHTML = filtered
      .map((t) => {
        const swatch = CATEGORY_COLORS[t.category] ?? '#6BE8F2';
        const amtFormatted = formatMoneyMinor(t.amount_minor, { showCents: true, prefix: '' });
        const prefix = t.direction === 'in' ? '+' : isMixed ? '-' : '';
        const catDisplay = t.category_label ?? t.category;
        return `
          <div class="receipt-item" data-txn-id="${this.escapeHtml(t.id)}" style="display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid #C7D2DD;font-family:'JetBrains Mono',monospace;font-size:13px;">
            <span style="width:10px;height:10px;background:${swatch};outline:1px solid #111;flex:none"></span>
            <div style="flex:1;min-width:0">
              <div style="display:flex;gap:8px;align-items:baseline">
                <strong style="font-weight:600;color:#111;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.escapeHtml(t.merchant)}</strong>
                <span style="font-size:13px;padding:2px 6px;border:1px solid #111;text-transform:uppercase;background:#DDE6EE">${this.escapeHtml(catDisplay)}</span>
                ${t.is_refund ? '<span style="font-size:13px;padding:2px 5px;background:#C9B8F0;color:#111;text-transform:uppercase">REFUND</span>' : ''}
              </div>
              <div style="font-size:14px;color:#5B6B7C;margin-top:3px;display:flex;gap:12px">
                <span>${this.escapeHtml(t.date)}</span>
                <span>ID: ${this.escapeHtml(t.id)}</span>
              </div>
            </div>
            <div style="font-weight:600;font-size:14px;white-space:nowrap">${prefix}${this.escapeHtml(this.currencySymbol)}${amtFormatted}</div>
          </div>
        `;
      })
      .join('');
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
