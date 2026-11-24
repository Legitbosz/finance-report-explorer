import gsap from 'gsap';
import { beforeAll, describe, expect, it } from 'vitest';
import { ingestFilesDeterministically } from '../pipeline/ingest-business.js';
import {
  BUDGETS_STORAGE_KEY,
  computeBudgetOverview,
  extractBudgetCategories,
  loadSavedBudgets,
  removeBudgetLimit,
  saveBudgetLimit,
  type BudgetStorageLike,
} from '../src/budgets/budgets-engine.js';
import { registerBespokeChapters } from '../src/chapters/bespoke/index.js';
import { StoryPlayer } from '../src/player/story-player.js';

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

class BudgetTestElement {
  public tagName: string;
  public id = '';
  private _className = '';
  public style: Record<string, string> & {
    setProperty: (k: string, v: string) => void;
    getPropertyValue: (k: string) => string;
  };
  public dataset: Record<string, string> = {};
  public attributes = new Map<string, string>();
  public children: BudgetTestElement[] = [];
  public parentElement: BudgetTestElement | null = null;
  public checked = false;
  public value = '';
  public type = '';
  public disabled = false;
  public width = 1920;
  public height = 1080;
  public clientWidth = 1920;
  public clientHeight = 1080;
  public scrollWidth = 400;
  public scrollHeight = 120;
  public offsetWidth = 1920;
  public offsetHeight = 60;
  public autoAlpha = 1;
  public opacity = 1;
  private _rawHtml = '';
  private _text = '';
  private listeners = new Map<string, Array<(e: unknown) => void>>();

  public readonly classList = {
    add: (...tokens: string[]) => {
      const set = new Set(this._className.split(/\s+/).filter(Boolean));
      tokens.forEach((t) => set.add(t));
      this._className = Array.from(set).join(' ');
    },
    remove: (...tokens: string[]) => {
      const set = new Set(this._className.split(/\s+/).filter(Boolean));
      tokens.forEach((t) => set.delete(t));
      this._className = Array.from(set).join(' ');
    },
    contains: (token: string) => this._className.split(/\s+/).filter(Boolean).includes(token),
    toggle: (token: string, force?: boolean) => {
      const has = this.classList.contains(token);
      const next = force ?? !has;
      if (next) this.classList.add(token);
      else this.classList.remove(token);
      return next;
    },
  };

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    const rawStyle: Record<string, unknown> = {};
    this.style = new Proxy(rawStyle, {
      get: (target, prop: string) => {
        if (prop === 'setProperty') {
          return (k: string, v: string) => {
            target[k] = v;
          };
        }
        if (prop === 'getPropertyValue') {
          return (k: string) => String(target[k] ?? '');
        }
        return target[prop] ?? '';
      },
      set: (target, prop: string, val: string) => {
        target[prop] = val;
        return true;
      },
    }) as BudgetTestElement['style'];
  }

  public get className(): string {
    return this._className;
  }

  public set className(val: string) {
    this._className = val;
  }

  public get firstElementChild(): BudgetTestElement | null {
    return this.children[0] ?? null;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    else if (name === 'class') this._className = value;
    else if (name === 'type') this.type = value;
    else if (name === 'value') this.value = value;
    else if (name === 'checked') this.checked = value !== 'false';
    else if (name.startsWith('data-')) {
      const camel = name.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      this.dataset[camel] = value;
    }
  }

  public getAttribute(name: string): string | null {
    if (name === 'id' && this.id) return this.id;
    if (name === 'class' && this._className) return this._className;
    return this.attributes.get(name) ?? null;
  }

  public get innerHTML(): string {
    if (this._rawHtml) return this._rawHtml;
    return this.children.map((c) => c.outerHTML).join('') || this._text;
  }

  public set innerHTML(html: string) {
    this._rawHtml = html;
    this._text = html.replace(/<[^>]+>/g, '');
    this.children = [];
    if (html.trim().length > 0) {
      parseHtmlInto(this, html);
    }
  }

  public get outerHTML(): string {
    const cls = this._className ? ` class="${this._className}"` : '';
    const idAttr = this.id ? ` id="${this.id}"` : '';
    return `<${this.tagName.toLowerCase()}${idAttr}${cls}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  public get textContent(): string {
    if (this.children.length > 0 && !this._rawHtml) {
      return this.children.map((c) => c.textContent).join('');
    }
    return this._text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
  }

  public set textContent(txt: string) {
    this._text = txt;
    this._rawHtml = txt;
    this.children = [];
  }

  public appendChild(child: BudgetTestElement): BudgetTestElement {
    this._rawHtml = '';
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  public getContext(): Record<string, unknown> {
    return {
      fillStyle: '#000',
      strokeStyle: '#000',
      lineWidth: 1,
      font: '12px sans-serif',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      globalAlpha: 1,
      clearRect: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      setTransform: () => {},
      translate: () => {},
      roundRect: () => {},
      measureText: (t: string) => ({ width: t.length * 8 }),
      fillText: () => {},
    };
  }

  public getBoundingClientRect() {
    return { left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080, x: 0, y: 0 };
  }

  public focus(): void {}
  public blur(): void {}

  public addEventListener(type: string, handler: (e: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(handler);
    this.listeners.set(type, arr);
  }

  public removeEventListener(type: string, handler: (e: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      arr.filter((fn) => fn !== handler)
    );
  }

  public dispatchEvent(ev: { type?: string }): boolean {
    const arr = this.listeners.get(ev.type ?? '') ?? [];
    arr.forEach((fn) => fn(ev));
    return true;
  }

  public click(): void {
    const arr = this.listeners.get('click') ?? [];
    const ev = { stopPropagation: () => {}, preventDefault: () => {}, target: this };
    arr.forEach((fn) => fn(ev));
  }

  public closest<T = BudgetTestElement>(selector: string): T | null {
    if (matchesSelector(this, selector)) return this as unknown as T;
    let cur = this.parentElement;
    while (cur) {
      if (matchesSelector(cur, selector)) return cur as unknown as T;
      cur = cur.parentElement;
    }
    return null;
  }

  public querySelector<T = BudgetTestElement>(selector: string): T | null {
    return (this.querySelectorAll<T>(selector)[0] ?? null) as T | null;
  }

  public querySelectorAll<T = BudgetTestElement>(selector: string): T[] {
    const groups = selector
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const out: BudgetTestElement[] = [];
    const visit = (node: BudgetTestElement) => {
      for (const child of node.children) {
        if (groups.some((g) => matchesSelector(child, g))) {
          out.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return out as unknown as T[];
  }
}

function matchesSelector(el: BudgetTestElement, selector: string): boolean {
  let rest = selector.trim();
  if (!rest) return false;
  const attrRegex = /\[([a-zA-Z0-9_-]+)(?:=["']?([^"'\]]+)["']?)?\]/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(rest)) !== null) {
    const actual = el.getAttribute(m[1]!);
    if (actual === null) return false;
    if (m[2] !== undefined && actual !== m[2]) return false;
  }
  rest = rest.replace(attrRegex, '');
  if (!rest) return true;
  if (rest.startsWith('#')) return el.id === rest.slice(1);
  if (rest.startsWith('.')) {
    return rest
      .slice(1)
      .split('.')
      .every((c) => el.classList.contains(c));
  }
  return el.tagName.toLowerCase() === rest.toLowerCase();
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'path', 'line', 'circle', 'rect']);

function parseHtmlInto(root: BudgetTestElement, html: string): void {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  const stack: BudgetTestElement[] = [root];
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(html)) !== null) {
    const full = m[0];
    const isClosing = full.startsWith('</');
    const tagName = m[1]!;
    const attrStr = m[2] ?? '';
    const isSelfClosing =
      m[3] === '/' || VOID_TAGS.has(tagName.toLowerCase()) || attrStr.trim().endsWith('/');
    const parent = stack[stack.length - 1] ?? root;

    if (!isClosing) {
      const el = new BudgetTestElement(tagName);
      const attrRe = /([a-zA-Z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(attrStr)) !== null) {
        el.setAttribute(am[1]!, am[2] ?? am[3] ?? am[4] ?? '');
      }
      el.parentElement = parent;
      parent.children.push(el);
      if (!isSelfClosing) {
        (el as unknown as { _innerStart?: number })._innerStart = tagRe.lastIndex;
        stack.push(el);
      }
    } else if (stack.length > 1) {
      const closed = stack.pop()!;
      const innerStart = (closed as unknown as { _innerStart?: number })._innerStart;
      if (innerStart !== undefined) {
        const slice = html.slice(innerStart, m.index);
        (closed as unknown as { _rawHtml: string })._rawHtml = slice;
        (closed as unknown as { _text: string })._text = slice.replace(/<[^>]+>/g, '');
      }
    }
  }
}

function setupBudgetDom(storage: BudgetStorageLike, search = '?byo=1') {
  gsap.config({ nullTargetWarn: false });
  const headEl = new BudgetTestElement('head');
  const bodyEl = new BudgetTestElement('body');
  const docEl = new BudgetTestElement('html');
  const rootEl = new BudgetTestElement('div');
  rootEl.id = 'app';
  bodyEl.appendChild(rootEl);

  const windowListeners = new Map<string, Array<(e: unknown) => void>>();

  class MockKeyboardEvent {
    public type: string;
    public key: string;
    public target: unknown = null;
    constructor(type: string, init?: { key?: string }) {
      this.type = type;
      this.key = init?.key ?? '';
    }
    public preventDefault(): void {}
    public stopPropagation(): void {}
  }

  (globalThis as unknown as { KeyboardEvent: unknown }).KeyboardEvent = MockKeyboardEvent;
  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
  (globalThis as unknown as { document: unknown }).document = {
    head: headEl,
    body: bodyEl,
    documentElement: docEl,
    fullscreenElement: null,
    createElement: (tag: string) => new BudgetTestElement(tag),
    getElementById: (id: string) =>
      id === 'app' ? rootEl : (headEl.querySelector(`#${id}`) ?? bodyEl.querySelector(`#${id}`)),
  };
  (globalThis as unknown as { window: unknown }).window = {
    location: { search },
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    localStorage: storage,
    matchMedia: () => ({ matches: true }),
    getComputedStyle: () => ({ fontSize: '48px', lineHeight: '52px' }),
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      const list = windowListeners.get(type) ?? [];
      list.push(fn);
      windowListeners.set(type, list);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      const list = windowListeners.get(type) ?? [];
      windowListeners.set(
        type,
        list.filter((item) => item !== fn)
      );
    },
    dispatchEvent: (ev: { type?: string }) => {
      const list = windowListeners.get(ev.type ?? '') ?? [];
      list.forEach((fn) => fn(ev));
      return true;
    },
  };

  return {
    rootEl: rootEl as unknown as HTMLElement,
    dispatchKey: (key: string) => {
      const ev = new MockKeyboardEvent('keydown', { key });
      (globalThis.window as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(ev);
    },
  };
}

const SAMPLE_LEDGER_CSV = [
  'Date,Description,Category,Amount',
  '2025-01-05,Salary,INCOME,250000',
  '2025-01-10,Freelance,INCOME,60000',
  '2025-01-02,Rent - January,HOUSING,-85000',
  '2025-01-06,Market shopping - food,FOOD,-42000',
  '2025-01-18,Market shopping - food,FOOD,-38000',
  '2025-01-12,Transport,TRANSPORT,-15000',
  '2025-01-15,Data subscription,UTILITIES,-12000',
  '2025-01-20,Electricity bill,UTILITIES,-20000',
].join('\n');

describe('Offline Budgets Engine & UI Integration', () => {
  beforeAll(() => {
    gsap.config({ nullTargetWarn: false });
  });

  it('discovers all ledger expense categories, calculates On track / Near limit / Over budget, and projects month-end spend', () => {
    const bundle = ingestFilesDeterministically([
      { name: 'sample-ledger.csv', content: SAMPLE_LEDGER_CSV, mimeType: 'text/csv' },
    ]);

    const discovered = extractBudgetCategories(bundle.transactions);
    expect(discovered.map((c) => c.displayLabel).sort()).toEqual([
      'Food',
      'Housing',
      'Transport',
      'Utilities',
    ]);

    const storage = createMemoryStorage();
    // Food spent = 80,000 -> budget 100,000 => 80% (Near limit), remaining 20,000, projected (day 20/31) = 124,000 => exceeds by 24,000
    saveBudgetLimit('groceries::food', 100_000 * 100, storage);
    // Housing spent = 85,000 -> budget 80,000 => 106.25% (Over budget), remaining -5,000, projected = 131,750
    saveBudgetLimit('rent::housing', 80_000 * 100, storage);
    // Transport spent = 15,000 -> budget 50,000 => 30% (On track), remaining 35,000, projected = 23,250 (no warning)
    saveBudgetLimit('transport::transport', 50_000 * 100, storage);

    const overview = computeBudgetOverview({
      transactions: bundle.transactions,
      days: bundle.days,
      savedBudgets: loadSavedBudgets(storage),
    });

    expect(overview.selectedMonth).toBe('2025-01');
    expect(overview.daysElapsed).toBe(20);
    expect(overview.daysInMonth).toBe(31);
    expect(overview.isPartialMonth).toBe(true);
    expect(overview.configuredCount).toBe(3);

    const food = overview.categories.find((c) => c.displayLabel === 'Food')!;
    expect(food.actualMinor).toBe(80_000 * 100);
    expect(food.remainingMinor).toBe(20_000 * 100);
    expect(food.status).toBe('near_limit');
    expect(food.statusLabel).toBe('Near limit');
    expect(food.projectedMinor).toBe(124_000 * 100);
    expect(food.projectedExceeds).toBe(true);
    expect(food.projectedExcessMinor).toBe(24_000 * 100);

    const housing = overview.categories.find((c) => c.displayLabel === 'Housing')!;
    expect(housing.status).toBe('over_budget');
    expect(housing.statusLabel).toBe('Over budget');
    expect(housing.remainingMinor).toBe(-5_000 * 100);
    expect(housing.projectedExceeds).toBe(true);

    const transport = overview.categories.find((c) => c.displayLabel === 'Transport')!;
    expect(transport.status).toBe('on_track');
    expect(transport.statusLabel).toBe('On track');
    expect(transport.remainingMinor).toBe(35_000 * 100);
    expect(transport.projectedMinor).toBe(23_250 * 100);
    expect(transport.projectedExceeds).toBe(false);

    const utilities = overview.categories.find((c) => c.displayLabel === 'Utilities')!;
    expect(utilities.status).toBe('unset');
    expect(utilities.budgetMinor).toBeNull();
    expect(utilities.projectedMinor).toBe(49_600 * 100);

    // Removing a budget persists deletion in localStorage
    removeBudgetLimit('rent::housing', storage);
    expect(loadSavedBudgets(storage)['rent::housing']).toBeUndefined();
  });

  it('uses actual spent as month-end projection for completed months in multi-month ledgers', () => {
    const multiMonthCsv = [
      'Date,Description,Category,Amount',
      '2025-01-10,Market shopping,FOOD,-40000',
      '2025-02-05,Corner grocer,FOOD,-25000',
    ].join('\n');

    const bundle = ingestFilesDeterministically([
      { name: 'multi-month.csv', content: multiMonthCsv, mimeType: 'text/csv' },
    ]);

    const janOverview = computeBudgetOverview({
      transactions: bundle.transactions,
      days: bundle.days,
      savedBudgets: { 'groceries::food': 50_000 * 100 },
      selectedMonth: '2025-01',
    });

    expect(janOverview.isPartialMonth).toBe(false);
    expect(janOverview.daysElapsed).toBe(31);
    const janFood = janOverview.categories.find((c) => c.displayLabel === 'Food')!;
    expect(janFood.projectedMinor).toBe(40_000 * 100);
    expect(janFood.projectedExceeds).toBe(false);
    expect(janFood.status).toBe('near_limit'); // 40k / 50k = 80%
  });

  it('integrates Budgets tab in StoryPlayer alongside Explore and Receipts, persists to localStorage, and opens Receipts cleanly', () => {
    const storage = createMemoryStorage();
    const { rootEl, dispatchKey } = setupBudgetDom(storage, '?byo=1');

    const initialBundle = ingestFilesDeterministically([
      { name: 'sample-ledger.csv', content: SAMPLE_LEDGER_CSV, mimeType: 'text/csv' },
    ]);

    const player = new StoryPlayer(rootEl, initialBundle);
    registerBespokeChapters(player);

    // Before file upload in BYO mode, Budgets/Explore HUD buttons exist and pressing B does not bypass start screen
    expect(rootEl.querySelector('#nav-budgets-btn')).not.toBeNull();
    expect(rootEl.querySelector('#hud-budgets-btn')).not.toBeNull();
    dispatchKey('b');
    expect(player.getState().mode).toBe('start');

    // Load dataset as if uploaded by user
    player.loadDataset(initialBundle, true);
    expect(player.getState().mode).toBe('story');

    // Open Budgets tab via HUD button
    rootEl.querySelector<HTMLButtonElement>('#hud-budgets-btn')!.click();
    expect(player.getState().mode).toBe('budgets');
    expect(player.budgetsOverlay.isActive()).toBe(true);

    // Set a monthly budget on Food (₦100,000) -> 80% Near limit + projected ₦124,000 warning
    const setFoodBtn = rootEl.querySelector<HTMLButtonElement>(
      '[data-testid="budget-set-btn-groceries-food"]'
    )!;
    expect(setFoodBtn).not.toBeNull();
    setFoodBtn.click();

    const amountInput = rootEl.querySelector<HTMLInputElement>('[data-testid="budget-amount-input"]')!;
    amountInput.value = '100000';
    rootEl.querySelector<HTMLButtonElement>('[data-testid="budget-save-btn"]')!.click();

    expect(rootEl.querySelector('[data-testid="budget-limit-groceries-food"]')?.textContent).toBe(
      '₦100,000'
    );
    expect(rootEl.querySelector('[data-testid="budget-actual-groceries-food"]')?.textContent).toBe(
      '₦80,000'
    );
    expect(rootEl.querySelector('[data-testid="budget-remaining-groceries-food"]')?.textContent).toBe(
      '₦20,000'
    );
    expect(rootEl.querySelector('[data-testid="budget-status-groceries-food"]')?.textContent).toBe(
      'Near limit'
    );
    expect(rootEl.querySelector('[data-testid="budget-projected-groceries-food"]')?.textContent).toBe(
      '₦124,000'
    );
    expect(
      rootEl.querySelector('[data-testid="budget-projection-warning-groceries-food"]')?.textContent
    ).toContain('will exceed budget by ₦24,000');

    // Live currency switch to USD updates Budgets amounts & alerts immediately with identical numbers
    player.setCurrencyCode('USD');
    expect(rootEl.querySelector('[data-testid="budget-limit-groceries-food"]')?.textContent).toBe(
      '$100,000'
    );
    expect(rootEl.querySelector('[data-testid="budget-actual-groceries-food"]')?.textContent).toBe(
      '$80,000'
    );
    expect(
      rootEl.querySelector('[data-testid="budget-projection-warning-groceries-food"]')?.textContent
    ).toContain('will exceed budget by $24,000');
    player.setCurrencyCode('NGN');

    // Verify localStorage saved it locally
    expect(storage.store.get(BUDGETS_STORAGE_KEY)).toBeDefined();

    // Edit budget to ₦150,000 -> On track, no warning
    rootEl
      .querySelector<HTMLButtonElement>('[data-testid="budget-edit-btn-groceries-food"]')!
      .click();
    const editInput = rootEl.querySelector<HTMLInputElement>('[data-testid="budget-amount-input"]')!;
    editInput.value = '150000';
    rootEl.querySelector<HTMLButtonElement>('[data-testid="budget-save-btn"]')!.click();

    expect(rootEl.querySelector('[data-testid="budget-status-groceries-food"]')?.textContent).toBe(
      'On track'
    );
    expect(
      rootEl.querySelector('[data-testid="budget-projection-warning-groceries-food"]')
    ).toBeNull();

    // Edit budget to ₦60,000 -> Over budget (-₦20,000 remaining)
    rootEl
      .querySelector<HTMLButtonElement>('[data-testid="budget-edit-btn-groceries-food"]')!
      .click();
    rootEl.querySelector<HTMLInputElement>('[data-testid="budget-amount-input"]')!.value = '60000';
    rootEl.querySelector<HTMLButtonElement>('[data-testid="budget-save-btn"]')!.click();
    expect(rootEl.querySelector('[data-testid="budget-status-groceries-food"]')?.textContent).toBe(
      'Over budget'
    );
    expect(rootEl.querySelector('[data-testid="budget-remaining-groceries-food"]')?.textContent).toBe(
      '-₦20,000'
    );

    // Clicking Receipts from Budgets opens ReceiptsDrawer cleanly
    rootEl.querySelector<HTMLButtonElement>('#budgets-receipts-btn')!.click();
    expect(player.receiptsDrawer.isOpen()).toBe(true);
    expect(rootEl.querySelector('#receipts-list')?.querySelectorAll('.receipt-item')).toHaveLength(6);
    player.receiptsDrawer.close();

    // Remove Food budget -> returns to No budget
    rootEl
      .querySelector<HTMLButtonElement>('[data-testid="budget-remove-btn-groceries-food"]')!
      .click();
    expect(rootEl.querySelector('[data-testid="budget-status-groceries-food"]')?.textContent).toBe(
      'No budget'
    );

    // Save Housing budget and recreate a fresh StoryPlayer instance to verify persistence across reloads
    rootEl
      .querySelector<HTMLButtonElement>('[data-testid="budget-set-btn-rent-housing"]')!
      .click();
    rootEl.querySelector<HTMLInputElement>('[data-testid="budget-amount-input"]')!.value = '90000';
    rootEl.querySelector<HTMLButtonElement>('[data-testid="budget-save-btn"]')!.click();

    player.destroy();

    const { rootEl: rootEl2 } = setupBudgetDom(storage, '?byo=1');
    const player2 = new StoryPlayer(rootEl2, initialBundle);
    registerBespokeChapters(player2);
    player2.loadDataset(initialBundle, true);
    player2.openBudgets();
    expect(rootEl2.querySelector('[data-testid="budget-limit-rent-housing"]')?.textContent).toBe(
      '₦90,000'
    );
    expect(rootEl2.querySelector('[data-testid="budget-status-rent-housing"]')?.textContent).toBe(
      'Near limit'
    );

    // Switching from Budgets -> Explore -> Story works cleanly
    rootEl2.querySelector<HTMLButtonElement>('#budgets-explore-btn')!.click();
    expect(player2.getState().mode).toBe('explore');
    expect(player2.budgetsOverlay.isActive()).toBe(false);

    rootEl2.querySelector<HTMLButtonElement>('#explore-budgets-btn')!.click();
    expect(player2.getState().mode).toBe('budgets');

    rootEl2.querySelector<HTMLButtonElement>('#budgets-close-btn')!.click();
    expect(player2.getState().mode).toBe('story');

    player2.destroy();
  });
});
