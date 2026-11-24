import gsap from 'gsap';
import { describe, expect, it } from 'vitest';
import { ingestFilesDeterministically } from '../pipeline/ingest-business.js';
import { registerBespokeChapters } from '../src/chapters/bespoke/index.js';
import {
  CURRENCY_OPTIONS,
  CURRENCY_STORAGE_KEY,
  DEFAULT_CURRENCY_CODE,
  loadSavedCurrencyCode,
  rewriteFactFormattedForCurrency,
  saveCurrencyCode,
  stripCurrencyPrefix,
  type CurrencyStorageLike,
} from '../src/currency/index.js';
import { StoryPlayer } from '../src/player/story-player.js';

const SAMPLE_LEDGER_CSV = [
  'Date,Description,Category,Amount',
  '2025-01-01,Salary,INCOME,250000',
  '2025-01-05,Freelance,INCOME,60000',
  '2025-01-03,Rent – January,HOUSING,-85000',
  '2025-01-06,Market shopping - food,FOOD,-42000',
  '2025-01-12,Market shopping - food,FOOD,-38000',
  '2025-01-15,Transport,TRANSPORT,-15000',
  '2025-01-18,Data subscription,UTILITIES,-12000',
  '2025-01-20,Electricity bill,UTILITIES,-20000',
].join('\n');

function createMemoryStorage(): CurrencyStorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

class CurrencyTestElement {
  public tagName: string;
  public id = '';
  private _className = '';
  public style: Record<string, string> & {
    setProperty: (k: string, v: string) => void;
    getPropertyValue: (k: string) => string;
  };
  public dataset: Record<string, string> = {};
  public attributes = new Map<string, string>();
  public children: CurrencyTestElement[] = [];
  public parentElement: CurrencyTestElement | null = null;
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
    }) as CurrencyTestElement['style'];
  }

  public get className(): string {
    return this._className;
  }

  public set className(val: string) {
    this._className = val;
  }

  public get options(): CurrencyTestElement[] {
    return this.children.filter((c) => c.tagName === 'OPTION');
  }

  public get firstElementChild(): CurrencyTestElement | null {
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

  public appendChild(child: CurrencyTestElement): CurrencyTestElement {
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

  public closest<T = CurrencyTestElement>(selector: string): T | null {
    if (matchesSelector(this, selector)) return this as unknown as T;
    let cur = this.parentElement;
    while (cur) {
      if (matchesSelector(cur, selector)) return cur as unknown as T;
      cur = cur.parentElement;
    }
    return null;
  }

  public querySelector<T = CurrencyTestElement>(selector: string): T | null {
    return (this.querySelectorAll<T>(selector)[0] ?? null) as T | null;
  }

  public querySelectorAll<T = CurrencyTestElement>(selector: string): T[] {
    const groups = selector
      .split(',')
      .map((s) => s.trim().split(/\s+/).filter(Boolean))
      .filter((parts) => parts.length > 0);
    const matchesChain = (el: CurrencyTestElement, parts: string[]): boolean => {
      if (!matchesSelector(el, parts[parts.length - 1]!)) return false;
      let cur = el.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (cur && !matchesSelector(cur, parts[i]!)) {
          cur = cur.parentElement;
        }
        if (!cur) return false;
        cur = cur.parentElement;
      }
      return true;
    };
    const out: CurrencyTestElement[] = [];
    const visit = (node: CurrencyTestElement) => {
      for (const child of node.children) {
        if (groups.some((parts) => matchesChain(child, parts))) {
          out.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return out as unknown as T[];
  }
}

function matchesSelector(el: CurrencyTestElement, selector: string): boolean {
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

function parseHtmlInto(root: CurrencyTestElement, html: string): void {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  const stack: CurrencyTestElement[] = [root];
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
      const el = new CurrencyTestElement(tagName);
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

function setupPlayerDom(storage: CurrencyStorageLike, search = '?byo=1') {
  gsap.config({ nullTargetWarn: false });
  const headEl = new CurrencyTestElement('head');
  const bodyEl = new CurrencyTestElement('body');
  const docEl = new CurrencyTestElement('html');
  const rootEl = new CurrencyTestElement('div');
  rootEl.id = 'app';
  bodyEl.appendChild(rootEl);

  const windowListeners = new Map<string, Array<(e: unknown) => void>>();

  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
  (globalThis as unknown as { document: unknown }).document = {
    head: headEl,
    body: bodyEl,
    documentElement: docEl,
    fullscreenElement: null,
    createElement: (tag: string) => new CurrencyTestElement(tag),
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
        list.filter((f) => f !== fn)
      );
    },
  };

  return { rootEl: rootEl as unknown as HTMLElement };
}

describe('Display Currency selector & persistence', () => {
  it('defaults to NGN (₦), includes required currencies, and persists selection locally', () => {
    const storage = createMemoryStorage();
    expect(DEFAULT_CURRENCY_CODE).toBe('NGN');
    expect(loadSavedCurrencyCode(storage)).toBe('NGN');

    const codes = CURRENCY_OPTIONS.map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['NGN', 'USD', 'GBP', 'EUR', 'GHS']));
    expect(CURRENCY_OPTIONS.length).toBeGreaterThanOrEqual(5);

    saveCurrencyCode('USD', storage);
    expect(storage.store.get(CURRENCY_STORAGE_KEY)).toBe('USD');
    expect(loadSavedCurrencyCode(storage)).toBe('USD');

    // Unknown codes fall back safely to default NGN
    expect(loadSavedCurrencyCode({ getItem: () => 'XYZ', setItem: () => {} })).toBe('NGN');
  });

  it('rewrites monetary facts cleanly without changing numbers or touching non-monetary facts', () => {
    const spendFact = {
      id: 'total_spend_usd',
      label: 'Total Outflow',
      value: 21200000,
      formatted: 'US$212,000',
      unit: 'usd' as const,
      txn_ids: [],
      computation: 'sum(outflows)',
    };
    expect(rewriteFactFormattedForCurrency(spendFact, '₦').formatted).toBe('₦212,000');
    expect(rewriteFactFormattedForCurrency(spendFact, '$').formatted).toBe('$212,000');
    expect(rewriteFactFormattedForCurrency(spendFact, '£').formatted).toBe('£212,000');
    expect(rewriteFactFormattedForCurrency(spendFact, '€').formatted).toBe('€212,000');
    expect(rewriteFactFormattedForCurrency(spendFact, '₵').formatted).toBe('₵212,000');

    const countFact = {
      id: 'total_transactions_count',
      label: 'Count',
      value: 8,
      formatted: '8',
      unit: 'count' as const,
      txn_ids: [],
      computation: 'count(all)',
    };
    expect(rewriteFactFormattedForCurrency(countFact, '₦').formatted).toBe('8');
    expect(stripCurrencyPrefix('US$212,000')).toBe('212,000');
    expect(stripCurrencyPrefix('₦212,000')).toBe('212,000');
  });

  it('renders selectors on landing and story HUD, defaults to NGN, updates every view on currency switch, and persists across reloads', () => {
    const storage = createMemoryStorage();
    const { rootEl } = setupPlayerDom(storage, '?byo=1');

    const bundle = ingestFilesDeterministically([
      { name: 'sample-ledger.csv', content: SAMPLE_LEDGER_CSV, mimeType: 'text/csv' },
    ]);

    const player = new StoryPlayer(rootEl, bundle);
    registerBespokeChapters(player);

    // Selectors are visible on landing, story HUD, and top bar
    const landingSelect = rootEl.querySelector<HTMLSelectElement>(
      '[data-testid="currency-selector-landing"]'
    )!;
    const storySelect = rootEl.querySelector<HTMLSelectElement>(
      '[data-testid="currency-selector-story"]'
    )!;
    const barSelect = rootEl.querySelector<HTMLSelectElement>(
      '[data-testid="currency-selector-bar"]'
    )!;

    expect(landingSelect).not.toBeNull();
    expect(storySelect).not.toBeNull();
    expect(barSelect).not.toBeNull();
    expect(landingSelect.value).toBe('NGN');
    expect(storySelect.value).toBe('NGN');
    expect(barSelect.value).toBe('NGN');
    expect(player.getCurrencyCode()).toBe('NGN');

    const optionValues = Array.from(landingSelect.options).map((o) => o.value);
    expect(optionValues).toEqual(expect.arrayContaining(['NGN', 'USD', 'GBP', 'EUR', 'GHS']));

    // Load dataset & check landing stat box + Chapter 01 stat cards + headlines in NGN
    player.loadDataset(bundle, true);
    expect(rootEl.querySelector('#start-stat-sup')?.textContent).toBe('₦');
    expect(rootEl.querySelector('#start-spend-val')?.textContent).toBe('212,000');

    player.goToChapter(0);
    const chapterHost = rootEl.querySelector<HTMLElement>('#chapter-host')!;
    expect(chapterHost.querySelector('[data-testid="metric-block-spend"]')?.textContent).toContain('₦');
    expect(chapterHost.querySelector('[data-testid="metric-block-spend"]')?.textContent).toContain('212,000');
    expect(chapterHost.querySelector('[data-testid="metric-block-count"]')?.textContent).toContain('₦');
    expect(chapterHost.querySelector('[data-testid="metric-block-count"]')?.textContent).toContain('310,000');

    // Switch currency via Story HUD select -> USD ($)
    storySelect.value = 'USD';
    storySelect.dispatchEvent({ type: 'change', stopPropagation() {} } as unknown as Event);

    expect(player.getCurrencyCode()).toBe('USD');
    expect(storage.store.get(CURRENCY_STORAGE_KEY)).toBe('USD');
    expect(landingSelect.value).toBe('USD');
    expect(barSelect.value).toBe('USD');
    expect(rootEl.querySelector('#start-stat-sup')?.textContent).toBe('$');
    expect(rootEl.querySelector('#start-spend-val')?.textContent).toBe('212,000');
    expect(chapterHost.querySelector('[data-testid="metric-block-spend"]')?.textContent).toContain('$');
    expect(chapterHost.querySelector('[data-testid="metric-block-spend"]')?.textContent).toContain('212,000');
    expect(chapterHost.querySelector('[data-testid="metric-block-count"]')?.textContent).toContain('$');
    expect(chapterHost.querySelector('[data-testid="metric-block-count"]')?.textContent).toContain('310,000');

    // Switch to GBP (£) and check Explore + Receipts + Budgets
    player.setCurrencyCode('GBP');
    player.openExplore();
    const foodChip = Array.from(rootEl.querySelectorAll<HTMLButtonElement>('#chips .chip')).find(
      (c) => c.dataset.displayLabel?.toUpperCase() === 'FOOD'
    )!;
    foodChip.click();
    expect(rootEl.querySelector('#exday')?.textContent).toContain('£80,000');

    // Open ReceiptsDrawer & switch live to EUR (€)
    player.openReceipts(
      'All Ledger Entries',
      bundle.transactions.map((t) => t.id)
    );
    expect(rootEl.querySelector('#receipts-summary-bar')?.textContent).toContain('NET +£98,000.00');
    player.setCurrencyCode('EUR');
    expect(rootEl.querySelector('#receipts-summary-bar')?.textContent).toContain('NET +€98,000.00');
    player.receiptsDrawer.close();
    expect(rootEl.querySelector('#exday')?.textContent).toContain('€80,000');

    // Open Budgets, set a budget, and switch to GHS (₵)
    player.openBudgets();
    rootEl
      .querySelector<HTMLButtonElement>('[data-testid="budget-set-btn-groceries-food"]')!
      .click();
    rootEl.querySelector<HTMLInputElement>('[data-testid="budget-amount-input"]')!.value = '100000';
    rootEl.querySelector<HTMLButtonElement>('[data-testid="budget-save-btn"]')!.click();
    expect(rootEl.querySelector('[data-testid="budget-limit-groceries-food"]')?.textContent).toBe(
      '€100,000'
    );

    player.setCurrencyCode('GHS');
    expect(rootEl.querySelector('[data-testid="budget-limit-groceries-food"]')?.textContent).toBe(
      '₵100,000'
    );
    expect(rootEl.querySelector('[data-testid="budget-actual-groceries-food"]')?.textContent).toBe(
      '₵80,000'
    );
    expect(
      rootEl.querySelector('[data-testid="budget-projection-warning-groceries-food"]')?.textContent
    ).toContain('will exceed budget by ₵24,000');

    player.destroy();

    // Recreate a fresh StoryPlayer on the same localStorage -> remembers GHS (₵)
    const { rootEl: rootEl2 } = setupPlayerDom(storage, '?byo=1');
    const player2 = new StoryPlayer(rootEl2, bundle);
    registerBespokeChapters(player2);
    expect(player2.getCurrencyCode()).toBe('GHS');
    expect(
      rootEl2.querySelector<HTMLSelectElement>('[data-testid="currency-selector-landing"]')?.value
    ).toBe('GHS');

    player2.loadDataset(bundle, true);
    player2.goToChapter(0);
    expect(
      rootEl2.querySelector('#chapter-host [data-testid="metric-block-spend"]')?.textContent
    ).toContain('₵');
    expect(
      rootEl2.querySelector('#chapter-host [data-testid="metric-block-spend"]')?.textContent
    ).toContain('212,000');

    player2.destroy();
  });
});
