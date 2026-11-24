import fs from 'node:fs';
import path from 'node:path';
import gsap from 'gsap';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DatasetBundle, RawIngestFile } from '../contracts/index.js';
import {
  ingestFilesDeterministically,
  verifyFactPlaceholders,
} from '../pipeline/ingest-business.js';
import { parseUniversalBusinessData } from '../pipeline/parse.js';
import { registerBespokeChapters } from '../src/chapters/bespoke/index.js';
import { processByoIngestion } from '../src/ingest/index.js';
import { extractFinancialRowsFromPdfLines } from '../src/ingest/pdf-parser.js';
import { StoryPlayer } from '../src/player/story-player.js';

const SAMPLE_SAAS_B2B_CSV = `Invoice Date,Vendor,Department,Description,Amount,Currency
2025-01-05,Stripe Enterprise Settlement,Revenue & ARR,Enterprise Annual Subscription Cohort Q1,185000.00,USD
2025-01-12,Amazon Web Services,Cloud & Infrastructure,AWS Production Cluster Jan,"($14,200.00)",USD
2025-01-18,Snowflake,Cloud & Infrastructure,Snowflake Data Warehouse Compute,-6400.00,USD
2025-02-05,Stripe Enterprise Settlement,Revenue & ARR,Enterprise Subscription Settlement Feb,192000.00,USD
2025-02-12,Amazon Web Services,Cloud & Infrastructure,AWS Production Cluster Feb,-14800.00,USD
2025-02-19,Snowflake,Cloud & Infrastructure,Snowflake Data Warehouse Compute,-6800.00,USD
2025-03-05,Stripe Enterprise Settlement,Revenue & ARR,Enterprise Subscription Settlement Mar,210000.00,USD
2025-03-12,Amazon Web Services,Cloud & Infrastructure,AWS GPU Cluster Scale-Up,-16500.00,USD
2025-03-22,Datadog,Cloud & Infrastructure,Observability Enterprise Annual,-4900.00,USD
2025-04-10,Nvidia Enterprise,AI CapEx & Hardware,H100 Rack Cluster Deposit,-48000.00,USD
2025-05-12,Amazon Web Services,Cloud & Infrastructure,AWS Production Cluster May,-15200.00,USD
2025-05-18,Snowflake,Cloud & Infrastructure,Snowflake Data Warehouse Compute,-7100.00,USD
2025-06-15,Nvidia Enterprise,AI CapEx & Hardware,H100 Rack Cluster Final Tranche,-72000.00,USD
2025-07-12,Amazon Web Services,Cloud & Infrastructure,AWS Production Cluster Jul,-15900.00,USD
2025-08-14,WeWork Enterprise,Facilities & Real Estate,HQ Floor Lease Q3,-24000.00,USD
2025-09-12,Amazon Web Services,Cloud & Infrastructure,AWS Production Cluster Sep,-16100.00,USD
2025-10-04,Stripe Enterprise Settlement,Revenue & ARR,Enterprise Q4 Expansion Cohort,265000.00,USD
2025-10-12,Amazon Web Services,Cloud & Infrastructure,AWS Q4 Peak Compute,-18400.00,USD
2025-10-15,Snowflake,Cloud & Infrastructure,Snowflake Q4 Analytics Surge,-8900.00,USD
2025-10-18,Deloitte Tax & Audit,Legal & Advisory,SOC2 & Annual Financial Audit,-22500.00,USD
2025-11-12,Amazon Web Services,Cloud & Infrastructure,AWS Production Cluster Nov,-17200.00,USD
2025-12-12,Amazon Web Services,Cloud & Infrastructure,AWS Production Cluster Dec,-17900.00,USD
`;

describe('Offline Client-Only Ingestion, Local PDF Parser & B2B StoryPlan Verification', () => {
  it('extracts structured financial rows deterministically from local PDF statement lines', () => {
    const samplePdfLines = [
      'ACME CLOUD CORP — OPERATING STATEMENT FY 2025',
      'Date Description Amount Balance',
      '01/05/2025 Stripe Enterprise Settlement +185,000.00 CR $412,500.00',
      '01/12/2025 Amazon Web Services Production ($14,200.00) $398,300.00',
      'Jan 18, 2025 Snowflake Data Warehouse 6,400.00 DR $391,900.00',
      '2025-02-05 Client Retainer Deposit 45,000.00 $436,900.00',
      'Opening Balance $227,500.00',
      'Page 1 of 2',
    ];
    const rows = extractFinancialRowsFromPdfLines(samplePdfLines);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      date: '2025-01-05',
      description: 'Stripe Enterprise Settlement',
      amount: '185000.00',
      tran_type: 'CREDIT',
    });
    expect(rows[1]).toMatchObject({
      date: '2025-01-12',
      description: 'Amazon Web Services Production',
      amount: '-14200.00',
      tran_type: 'DEBIT',
    });
    expect(rows[2]).toMatchObject({
      date: '2025-01-18',
      description: 'Snowflake Data Warehouse',
      amount: '-6400.00',
      tran_type: 'DEBIT',
    });
    expect(rows[3]).toMatchObject({
      date: '2025-02-05',
      description: 'Client Retainer Deposit',
      amount: '45000.00',
      tran_type: 'CREDIT',
    });
  });

  it('processes BYO datasets 100% locally in the browser with zero network fetch calls', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = ((() => {
      fetchCalls += 1;
      return Promise.reject(new Error('Network fetch must not be called in offline mode'));
    }) as unknown) as typeof fetch;

    try {
      const bundle = await processByoIngestion({
        files: [
          {
            name: 'acme_cloud_fy2025.csv',
            content: SAMPLE_SAAS_B2B_CSV,
            mimeType: 'text/csv',
            encoding: 'utf8',
          },
        ],
        entityNameHint: 'Acme Cloud Corp',
      });

      expect(fetchCalls).toBe(0);
      expect(bundle.transactions.length).toBe(22);
      expect(bundle.plan.person_name).toBe('Acme Cloud Corp');
      expect(bundle.plan.business_meta?.generated_by).toBe('deterministic');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses arbitrary B2B CSV ledgers and generates a 100% fact-verified B2B StoryPlan + DatasetBundle', () => {
    const parsed = parseUniversalBusinessData(SAMPLE_SAAS_B2B_CSV, 'acme_cloud_fy2025.csv');
    expect(parsed.rows.length).toBe(22);

    const files: RawIngestFile[] = [
      {
        name: 'acme_cloud_fy2025.csv',
        content: SAMPLE_SAAS_B2B_CSV,
        mimeType: 'text/csv',
      },
    ];

    const bundle = ingestFilesDeterministically(files, {
      entityName: 'Acme Cloud Corp',
      isB2B: true,
    });

    expect(bundle.transactions.length).toBe(22);
    expect(bundle.days.length).toBe(365);
    expect(bundle.plan.person_name).toBe('Acme Cloud Corp');
    expect(bundle.plan.business_meta).toBeDefined();
    expect(bundle.plan.business_meta?.archetype).toBe('saas_arr');

    // Verify procedural B2B facts exist and have non-empty txn_ids
    const factMap = new Map(bundle.facts.map((f) => [f.id, f]));
    expect(factMap.get('total_inflow_usd')?.value).toBeGreaterThan(0);
    expect(factMap.get('studio_total_with_gear_spend')?.value).toBeGreaterThan(0);
    expect(factMap.get('top_merchant_name')?.formatted).toBe('AWS');
    expect(factMap.get('second_coffee_merchant_name')?.formatted).toBe('Snowflake');

    // Verify strict Rule 1 & Rule 2: zero raw digits outside {fact:id} placeholders across the entire B2B StoryPlan
    const oneLineCheck = verifyFactPlaceholders(bundle.plan.one_line, factMap, '');
    expect(oneLineCheck.valid).toBe(true);

    const subCheck = verifyFactPlaceholders(bundle.plan.personality.subtitle, factMap, '');
    expect(subCheck.valid).toBe(true);

    for (const ch of bundle.plan.chapters) {
      if (ch.headline) {
        const hCheck = verifyFactPlaceholders(ch.headline, factMap, '');
        expect(hCheck.valid).toBe(true);
      }
      if (ch.body) {
        const bCheck = verifyFactPlaceholders(ch.body, factMap, '');
        expect(bCheck.valid).toBe(true);
      }
    }
  });

  it('ingests the 505-row sample_b2b_data/nimbus_cloud_saas_fy2025.csv and 3-file multi_table_cfo_audit bundle cleanly', () => {
    const sampleDir = path.resolve(process.cwd(), '..', 'sample_b2b_data');
    const singleCsvPath = path.join(sampleDir, 'nimbus_cloud_saas_fy2025.csv');
    if (!fs.existsSync(singleCsvPath)) return;

    const singleContent = fs.readFileSync(singleCsvPath, 'utf8');
    const singleBundle = ingestFilesDeterministically(
      [{ name: 'nimbus_cloud_saas_fy2025.csv', content: singleContent, mimeType: 'text/csv' }],
      { entityName: 'Nimbus AI Cloud Corp', isB2B: true }
    );
    expect(singleBundle.transactions.length).toBe(505);
    expect(singleBundle.plan.chapters.length).toBeGreaterThanOrEqual(10);

    const multiDir = path.join(sampleDir, 'multi_table_cfo_audit');
    const multiFiles: RawIngestFile[] = [
      {
        name: '01_revenue_and_arr_settlements_2025.csv',
        content: fs.readFileSync(
          path.join(multiDir, '01_revenue_and_arr_settlements_2025.csv'),
          'utf8'
        ),
        mimeType: 'text/csv',
      },
      {
        name: '02_cloud_and_opex_ledger_2025.csv',
        content: fs.readFileSync(path.join(multiDir, '02_cloud_and_opex_ledger_2025.csv'), 'utf8'),
        mimeType: 'text/csv',
      },
      {
        name: '03_capex_and_treasury_2025.json',
        content: fs.readFileSync(path.join(multiDir, '03_capex_and_treasury_2025.json'), 'utf8'),
        mimeType: 'application/json',
      },
    ];
    const multiBundle = ingestFilesDeterministically(multiFiles, {
      entityName: 'Nimbus AI Cloud Corp',
      isB2B: true,
    });
    expect(multiBundle.transactions.length).toBe(505);
  });

  it('ingests .xlsx Excel workbooks (including multi-tab trading logs with merged title rows, serial dates & subtotals)', () => {
    const sampleDir = path.resolve(process.cwd(), '..', 'sample_b2b_data');
    const nimbusXlsxPath = path.join(sampleDir, 'nimbus_cloud_saas_fy2025.xlsx');
    if (fs.existsSync(nimbusXlsxPath)) {
      const b64 = fs.readFileSync(nimbusXlsxPath).toString('base64');
      const nimbusBundle = ingestFilesDeterministically([
        {
          name: 'nimbus_cloud_saas_fy2025.xlsx',
          content: b64,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          encoding: 'base64',
        },
      ]);
      expect(nimbusBundle.transactions.length).toBe(505);
      expect(nimbusBundle.plan.person_name).toBe('Nimbus Cloud SaaS');
    }

    const northbankPath = path.resolve(
      process.cwd(),
      '..',
      '..',
      'knowledge_work',
      'sample_data_sheets',
      'northbank_coffee_2025-26.xlsx'
    );
    if (fs.existsSync(northbankPath)) {
      const b64 = fs.readFileSync(northbankPath).toString('base64');
      const nbBundle = ingestFilesDeterministically([
        {
          name: 'northbank_coffee_2025-26.xlsx',
          content: b64,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          encoding: 'base64',
        },
      ]);
      expect(nbBundle.plan.person_name).toBe('Northbank Coffee');
      expect(nbBundle.plan.business_meta?.fiscal_period_label).toBe('FY 2025–26');
      expect(nbBundle.plan.business_meta?.currency_symbol).toBe('£');
      expect(nbBundle.plan.chapters[0]?.params.blocks?.[0]?.unit_sup).toBe('£');
      expect(nbBundle.days.length).toBe(365);
      expect(nbBundle.days[0]?.date).toBe('2025-10-01');
      expect(nbBundle.days[364]?.date).toBe('2026-09-30');
      const totalFact = nbBundle.facts.find((f) => f.id === 'total_spend_usd');
      expect(totalFact?.value).toBe(225162500);
      const studioMonthsFact = nbBundle.facts.find((f) => f.id === 'studio_months_span');
      expect(Number(studioMonthsFact?.value)).toBeGreaterThan(0);
      const octFact = nbBundle.facts.find((f) => f.id === 'october_spend_usd');
      expect(Number(octFact?.value)).toBeGreaterThan(0);
      const decFact = nbBundle.facts.find((f) => f.id === 'december_bonus_pay_usd');
      expect(Number(decFact?.value)).toBeGreaterThan(0);
      const janFact = nbBundle.facts.find((f) => f.id === 'jan_tech_spend');
      expect(Number(janFact?.value)).toBeGreaterThan(0);
    }
  });
});

/**
 * Lightweight DOM & Window implementation for mounting StoryPlayer and all 13 chapters
 * in Node Vitest environment without external browser dependencies.
 */
class TestDomElement {
  public tagName: string;
  public id = '';
  private _className = '';
  public style: Record<string, string> & {
    setProperty: (k: string, v: string) => void;
    getPropertyValue: (k: string) => string;
  };
  public dataset: Record<string, string> = {};
  public attributes = new Map<string, string>();
  public children: TestDomElement[] = [];
  public parentElement: TestDomElement | null = null;
  public checked = false;
  public value = '';
  public type = '';
  public disabled = false;
  public files: FileList | null = null;
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
  public color = '#1C1C1B';
  public clipPath = 'none';
  public scaleX = 1;
  public scaleY = 1;
  public x = 0;
  public y = 0;
  public yPercent = 0;
  public transformOrigin = '50% 50%';
  private _rawHtml = '';
  private _text = '';
  private listeners = new Map<string, Array<(e: unknown) => void>>();

  public readonly classList = {
    add: (...tokens: string[]) => {
      const set = new Set(this.classListArray());
      tokens.forEach((t) => set.add(t));
      this._className = Array.from(set).join(' ');
    },
    remove: (...tokens: string[]) => {
      const set = new Set(this.classListArray());
      tokens.forEach((t) => set.delete(t));
      this._className = Array.from(set).join(' ');
    },
    contains: (token: string) => this.classListArray().includes(token),
    toggle: (token: string, force?: boolean) => {
      const has = this.classListArray().includes(token);
      const next = force ?? !has;
      if (next) this.classList.add(token);
      else this.classList.remove(token);
      return next;
    },
  };

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    const rawStyle: Record<string, unknown> = {};
    const onCssText = (val: string) => this.parseStyleString(val);
    this.style = new Proxy(rawStyle, {
      get(target, prop: string) {
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
      set(target, prop: string, val: string) {
        target[prop] = val;
        if (prop === 'cssText' && typeof val === 'string') {
          onCssText(val);
        }
        return true;
      },
    }) as TestDomElement['style'];
  }

  public get className(): string {
    return this._className;
  }

  public set className(val: string) {
    this._className = val;
  }

  private classListArray(): string[] {
    return this._className.split(/\s+/).filter(Boolean);
  }

  public get firstElementChild(): TestDomElement | null {
    return this.children[0] ?? null;
  }

  public get lastElementChild(): TestDomElement | null {
    return this.children[this.children.length - 1] ?? null;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    else if (name === 'class') this._className = value;
    else if (name === 'style') this.parseStyleString(value);
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

  public parseStyleString(css: string): void {
    css.split(';').forEach((part) => {
      const idx = part.indexOf(':');
      if (idx > 0) {
        const rawKey = part.slice(0, idx).trim();
        const camelKey = rawKey.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
        const v = part.slice(idx + 1).trim();
        this.style[rawKey] = v;
        this.style[camelKey] = v;
        if (camelKey === 'width' && v.endsWith('px')) {
          const parsed = Number.parseFloat(v);
          if (!Number.isNaN(parsed)) this.clientWidth = parsed;
        }
        if (camelKey === 'height' && v.endsWith('px')) {
          const parsed = Number.parseFloat(v);
          if (!Number.isNaN(parsed)) this.clientHeight = parsed;
        }
      }
    });
  }

  public get innerHTML(): string {
    if (this._rawHtml) return this._rawHtml;
    if (this.children.length > 0) {
      return this.children.map((c) => c.outerHTML).join('');
    }
    return this._text;
  }

  public set innerHTML(html: string) {
    this._rawHtml = html;
    this._text = html.replace(/<[^>]+>/g, '');
    this.children = [];
    if (html.trim().length > 0) {
      parseTestHtmlInto(this, html);
    }
  }

  public get outerHTML(): string {
    const tag = this.tagName.toLowerCase();
    const cls = this._className ? ` class="${this._className}"` : '';
    const idAttr = this.id ? ` id="${this.id}"` : '';
    const dataAttrs = Object.entries(this.dataset)
      .map(([k, v]) => ` data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${v}"`)
      .join('');
    return `<${tag}${idAttr}${cls}${dataAttrs}>${this.innerHTML}</${tag}>`;
  }

  public get textContent(): string {
    if (this.children.length > 0 && !this._rawHtml) {
      return this.children.map((c) => c.textContent).join('');
    }
    return this._text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ');
  }

  public set textContent(txt: string) {
    this._text = txt;
    this._rawHtml = txt;
    this.children = [];
  }

  public appendChild(child: TestDomElement): TestDomElement {
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
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      bezierCurveTo: () => {},
      arc: () => {},
      rect: () => {},
      fill: () => {},
      stroke: () => {},
      clip: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      translate: () => {},
      rotate: () => {},
      setTransform: () => {},
      setLineDash: () => {},
      fillText: () => {},
      strokeText: () => {},
      measureText: (txt: string) => ({ width: String(txt ?? '').length * 14 }),
      getImageData: (_x: number, _y: number, w = 16, h = 16) => ({
        data: new Uint8ClampedArray(Math.min(w * h * 4, 4096)),
      }),
      putImageData: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      drawImage: () => {},
    };
  }

  public getBoundingClientRect(): {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    x: number;
    y: number;
  } {
    return {
      left: 0,
      top: 0,
      right: 1920,
      bottom: 1080,
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
    };
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

  public closest<T = TestDomElement>(selector: string): T | null {
    if (matchesTestSelector(this, selector)) return this as unknown as T;
    let cur = this.parentElement;
    while (cur) {
      if (matchesTestSelector(cur, selector)) return cur as unknown as T;
      cur = cur.parentElement;
    }
    return null;
  }

  public querySelector<T = TestDomElement>(selector: string): T | null {
    return (this.querySelectorAll<T>(selector)[0] ?? null) as T | null;
  }

  public querySelectorAll<T = TestDomElement>(selector: string): T[] {
    const groups = selector
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const out: TestDomElement[] = [];
    const visit = (node: TestDomElement) => {
      for (const child of node.children) {
        if (groups.some((g) => matchesTestSelector(child, g))) {
          out.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return out as unknown as T[];
  }
}

function matchesSingleTestToken(el: TestDomElement, token: string): boolean {
  if (!token) return false;
  if (token === '*') return true;
  let rest = token;
  let notToken: string | null = null;
  const notMatch = rest.match(/:not\(([^)]+)\)/);
  if (notMatch) {
    notToken = notMatch[1]!;
    rest = rest.replace(notMatch[0], '');
  }
  if (notToken && matchesSingleTestToken(el, notToken)) {
    return false;
  }

  const attrRegex = /\[([a-zA-Z0-9_-]+)(?:=["']?([^"'\]]+)["']?)?\]/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(rest)) !== null) {
    const attrName = m[1]!;
    const attrVal = m[2];
    const actual = el.getAttribute(attrName);
    if (actual === null) return false;
    if (attrVal !== undefined && actual !== attrVal) return false;
  }
  const withoutAttrs = rest.replace(attrRegex, '');
  if (!withoutAttrs) return true;

  if (withoutAttrs.startsWith('#')) {
    return el.id === withoutAttrs.slice(1);
  }
  if (withoutAttrs.startsWith('.')) {
    const classes = withoutAttrs.slice(1).split('.');
    return classes.every((c) => el.classList.contains(c));
  }
  if (withoutAttrs.includes('.')) {
    const [tagPart, ...clsParts] = withoutAttrs.split('.');
    if (tagPart && el.tagName.toLowerCase() !== tagPart.toLowerCase()) return false;
    return clsParts.every((c) => el.classList.contains(c));
  }
  return el.tagName.toLowerCase() === withoutAttrs.toLowerCase();
}

function matchesTestSelector(el: TestDomElement, selector: string): boolean {
  const normalized = selector.replace(/\s*>\s*/g, ' > ').trim();
  const parts = normalized.split(/\s+/);
  if (parts.length === 1) {
    return matchesSingleTestToken(el, parts[0]!);
  }
  if (!matchesSingleTestToken(el, parts[parts.length - 1]!)) return false;
  let cur = el.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    const token = parts[i]!;
    if (token === '>') {
      const parentToken = parts[i - 1];
      if (!parentToken || !cur || !matchesSingleTestToken(cur, parentToken)) return false;
      cur = cur.parentElement;
      i -= 1;
      continue;
    }
    while (cur && !matchesSingleTestToken(cur, token)) {
      cur = cur.parentElement;
    }
    if (!cur) return false;
    cur = cur.parentElement;
  }
  return true;
}

const TEST_VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'path', 'line', 'circle', 'rect']);

function parseTestAttributes(el: TestDomElement, attrStr: string): void {
  const re = /([a-zA-Z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    const name = m[1]!;
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    el.setAttribute(name, val);
  }
}

function parseTestHtmlInto(root: TestDomElement, html: string): void {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  const stack: TestDomElement[] = [root];
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(html)) !== null) {
    const full = m[0];
    const isClosing = full.startsWith('</');
    const tagName = m[1]!;
    const attrStr = m[2] ?? '';
    const isSelfClosing =
      m[3] === '/' || TEST_VOID_TAGS.has(tagName.toLowerCase()) || attrStr.trim().endsWith('/');

    const parent = stack[stack.length - 1] ?? root;

    if (!isClosing) {
      const el = new TestDomElement(tagName);
      parseTestAttributes(el, attrStr);
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

class MockKeyboardEvent {
  public readonly type: string;
  public readonly key: string;
  public defaultPrevented = false;
  public target: unknown = null;

  constructor(type: string, init?: { key?: string }) {
    this.type = type;
    this.key = init?.key ?? '';
  }

  public preventDefault(): void {
    this.defaultPrevented = true;
  }

  public stopPropagation(): void {}
}

function setupStoryPlayerTestDom(search = '?byo=1'): {
  rootEl: HTMLElement;
  dispatchWindowKeydown: (key: string) => void;
} {
  gsap.config({ nullTargetWarn: false });
  const headEl = new TestDomElement('head');
  const bodyEl = new TestDomElement('body');
  const docEl = new TestDomElement('html');
  docEl.clientWidth = 1920;
  docEl.clientHeight = 1080;
  const rootEl = new TestDomElement('div');
  rootEl.id = 'app';
  bodyEl.appendChild(rootEl);

  const windowListeners = new Map<string, Array<(e: unknown) => void>>();

  (globalThis as unknown as { KeyboardEvent: unknown }).KeyboardEvent = MockKeyboardEvent;
  (globalThis as unknown as { document: unknown }).document = {
    head: headEl,
    body: bodyEl,
    documentElement: docEl,
    fullscreenElement: null,
    createElement: (tag: string) => new TestDomElement(tag),
    getElementById: (id: string) => {
      if (id === 'app') return rootEl;
      return headEl.querySelector(`#${id}`) ?? bodyEl.querySelector(`#${id}`);
    },
  };

  (globalThis as unknown as { window: unknown }).window = {
    location: { search },
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: true }),
    getComputedStyle: (el: TestDomElement) => ({
      fontSize: el.style.fontSize || '48px',
      lineHeight: el.style.lineHeight || '52px',
    }),
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
    dispatchWindowKeydown: (key: string) => {
      const ev = new MockKeyboardEvent('keydown', { key });
      (globalThis.window as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(ev);
    },
  };
}

function buildMultiYear2025To2026B2BCsv(): string {
  const rows: string[] = ['Invoice Date,Vendor,Department,Description,Amount,Currency'];
  const months = [
    '2025-10',
    '2025-11',
    '2025-12',
    '2026-01',
    '2026-02',
    '2026-03',
    '2026-04',
    '2026-05',
    '2026-06',
    '2026-07',
    '2026-08',
    '2026-09',
  ];
  months.forEach((ym, idx) => {
    rows.push(
      `${ym}-02,Stripe UK Settlement Clearing,Revenue & Sales,Monthly Commercial Settlement Cycle ${idx + 1},320000.00,GBP`
    );
    rows.push(
      `${ym}-08,Northbank Coffee Roasters — Southbank Flagship,Inventory & Green Bean Supply,Direct Trade Espresso Roast Lot #${101 + idx},-42500.00,GBP`
    );
    rows.push(
      `${ym}-14,Global Cloud Infrastructure Services Ltd — EMEA Cluster,Cloud & POS Systems,Multi-Region Telemetry & Point-of-Sale Hosting,-18900.00,GBP`
    );
    rows.push(
      `${ym}-19,Metropolitan Commercial Property Management LLP,Premises & Leasehold,Flagship Roastery & Café Quarter Lease,-64000.00,GBP`
    );
    rows.push(
      `${ym}-24,Highland Dairy & Oat Barista Distributors UK,Perishables & Cold Chain,Weekly Chilled Barista Supply Delivery,-14200.00,GBP`
    );
  });
  // Add a 7-day連続 operating deployment streak in May 2026 + large flagship buildout commitment
  for (let d = 10; d <= 16; d++) {
    rows.push(
      `2026-05-${String(d).padStart(2, '0')},Northbank Coffee Roasters — Southbank Flagship,Flagship Roastery Expansion,La Marzocco KB90 & Probat Roaster Commissioning Day ${d - 9},-28500.00,GBP`
    );
  }
  rows.push(
    '2026-05-18,Probat Werke Industrial Roastery Engineering GmbH,Flagship Roastery Expansion,Turnkey P60 Drum Roaster & Afterburner Installation,-241625.00,GBP'
  );
  return rows.join('\n') + '\n';
}

const FORBIDDEN_B2B_COPY_PHRASES = [
  'Longest Coffee Streak',
  'Coastal Getaway',
  'Favourite Coastal Getaway',
  'Ritual calendar',
  'Peak ritual',
  'MERCHANT UNSCRAMBLE',
  'Merchant gibberish',
  'EVERYDAY PURCHASES',
  'ONLY IN YOUR APP',
  'YOU ARE',
  'paydays in orange',
  'Payday vs normal',
  'Payday Spending Multiplier',
  'Top Merchant Visits',
  'SETTLEMENTSS',
  'CLOSESS',
] as const;

const ALL_13_B2B_CHAPTER_KEYS = [
  'pour',
  'year_as_squares',
  'your_place',
  'bespoke_studio',
  'streak',
  'getaway',
  'bespoke_coffee',
  'heartbeat',
  'big_one',
  'shatter',
  'personality',
  'one_line',
  'share_card',
] as const;

describe('End-to-End B2B UI, Copy & Layout Verification (Review Pass 1)', () => {
  beforeAll(() => {
    gsap.config({ nullTargetWarn: false });
  });

  it('1. verifies Landing Screen (#start-screen) B2B copy, offline privacy notice, and absence of removed Drive/AI/Ask UI', () => {
    const { rootEl } = setupStoryPlayerTestDom('?byo=1');
    const initialBundle = ingestFilesDeterministically(
      [
        {
          name: 'acme_cloud_fy2025.csv',
          content: SAMPLE_SAAS_B2B_CSV,
          mimeType: 'text/csv',
        },
      ],
      { entityName: 'Acme Cloud Corp', isB2B: true }
    );

    const player = new StoryPlayer(rootEl, initialBundle);
    registerBespokeChapters(player);

    const startScreen = rootEl.querySelector<HTMLElement>('#start-screen');
    expect(startScreen).not.toBeNull();

    // Title is "Finance Story." and no "Data Story" anywhere
    const heroTitle = rootEl.querySelector<HTMLElement>('#start-hero-title');
    expect(heroTitle?.textContent?.trim()).toBe('Finance Story.');
    expect(rootEl.innerHTML).not.toContain('Data Story');

    // Top-left is "FINANCE STORY · INTERACTIVE SUMMARY" when awaiting BYO upload
    const topLeft = rootEl.querySelector<HTMLElement>('#start-top-left-label');
    expect(topLeft?.textContent?.trim()).toBe('FINANCE STORY · INTERACTIVE SUMMARY');

    // Top-right is "LEDGER ANALYSIS" (no "VERIFIED")
    const topRight = rootEl.querySelector<HTMLElement>('#start-top-right-label');
    expect(topRight?.textContent?.trim()).toBe('LEDGER ANALYSIS');
    expect(topRight?.textContent).not.toContain('VERIFIED');

    // Bottom-left "DEMO TERMS" and bottom-right "DETERMINISTIC ENGINE" are completely gone
    expect(startScreen?.innerHTML).not.toContain('DEMO TERMS');
    expect(startScreen?.innerHTML).not.toContain('DETERMINISTIC ENGINE');

    // Removed inputs/controls: entity input, Google Drive import, Deep Agent toggle, Ask buttons/overlay
    expect(rootEl.querySelector('#byo-entity-input')).toBeNull();
    expect(rootEl.querySelector('#byo-drive-input')).toBeNull();
    expect(rootEl.querySelector('#byo-drive-fetch-btn')).toBeNull();
    expect(rootEl.querySelector('#byo-deep-agent-toggle')).toBeNull();
    expect(rootEl.querySelector('#nav-ask-btn')).toBeNull();
    expect(rootEl.querySelector('#hud-ask-btn')).toBeNull();
    expect(rootEl.querySelector('#o-ask')).toBeNull();

    // #byo-upload-disclaimer clearly tells users files are processed locally and never uploaded
    const disclaimerEl = rootEl.querySelector<HTMLElement>('#byo-upload-disclaimer');
    expect(disclaimerEl).not.toBeNull();
    expect(disclaimerEl?.textContent).toContain(
      'Processed 100% locally — your files never leave your computer.'
    );
    expect(disclaimerEl?.textContent).toContain(
      'All Excel (.xlsx), CSV, JSON, and PDF parsing happens offline right in your browser.'
    );
    expect(disclaimerEl?.textContent).toContain(
      'Nothing is uploaded to any server, no AI or external APIs are used, and no sign-in is required.'
    );
    expect(
      disclaimerEl?.querySelector('a[href="https://ai.google.dev/gemini-api/terms"]')
    ).toBeNull();

    player.destroy();
  });

  it('2. verifies D/d keyboard shortcut removal and "Upload Data" button labels without [D]', () => {
    const { rootEl, dispatchWindowKeydown } = setupStoryPlayerTestDom('?byo=1');
    const bundle = ingestFilesDeterministically(
      [
        {
          name: 'acme_cloud_fy2025.csv',
          content: SAMPLE_SAAS_B2B_CSV,
          mimeType: 'text/csv',
        },
      ],
      { entityName: 'Acme Cloud Corp', isB2B: true }
    );

    const player = new StoryPlayer(rootEl, bundle);
    registerBespokeChapters(player);
    player.loadDataset(bundle, true);

    const startScreen = rootEl.querySelector<HTMLElement>('#start-screen')!;
    expect(player.getState().started).toBe(true);
    expect(player.getState().mode).toBe('story');
    expect(startScreen.style.display).toBe('none');

    // Verify #nav-data-btn and #hud-data-btn say "Upload Data" (no [D])
    const navDataBtn = rootEl.querySelector<HTMLElement>('#nav-data-btn');
    const hudDataBtn = rootEl.querySelector<HTMLElement>('#hud-data-btn');
    expect(navDataBtn?.textContent?.trim()).toBe('Upload Data');
    expect(hudDataBtn?.textContent?.trim()).toBe('Upload Data');
    expect(navDataBtn?.textContent).not.toContain('[D]');
    expect(hudDataBtn?.textContent).not.toContain('[D]');

    // Dispatching 'd' and 'D' keydown events must NOT re-open #start-screen
    dispatchWindowKeydown('d');
    expect(player.getState().mode).toBe('story');
    expect(startScreen.style.display).toBe('none');

    dispatchWindowKeydown('D');
    expect(player.getState().mode).toBe('story');
    expect(startScreen.style.display).toBe('none');

    player.destroy();
  });

  it('3. verifies multi-year (2025–26) period rendering in PourChapter (#ttlt and #ttlB)', () => {
    const { rootEl } = setupStoryPlayerTestDom('?byo=1');

    // Test both synthetic 2025-26 dataset and real northbank_coffee_2025-26.xlsx if present
    const syntheticMultiYearBundle = ingestFilesDeterministically(
      [
        {
          name: 'northbank_flagship_2025-26.csv',
          content: buildMultiYear2025To2026B2BCsv(),
          mimeType: 'text/csv',
        },
      ],
      { entityName: 'Northbank Coffee Roasters — Southbank Flagship', isB2B: true }
    );

    const bundlesToVerify: DatasetBundle[] = [syntheticMultiYearBundle];
    const northbankPath = path.resolve(
      process.cwd(),
      '..',
      '..',
      'knowledge_work',
      'sample_data_sheets',
      'northbank_coffee_2025-26.xlsx'
    );
    if (fs.existsSync(northbankPath)) {
      bundlesToVerify.push(
        ingestFilesDeterministically([
          {
            name: 'northbank_coffee_2025-26.xlsx',
            content: fs.readFileSync(northbankPath).toString('base64'),
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            encoding: 'base64',
          },
        ])
      );
    }

    const player = new StoryPlayer(rootEl, syntheticMultiYearBundle);
    registerBespokeChapters(player);

    for (const bundle of bundlesToVerify) {
      player.loadDataset(bundle, true);
      player.goToChapter(0);

      const chapterHost = rootEl.querySelector<HTMLElement>('#chapter-host')!;
      const ttlt = chapterHost.querySelector<HTMLElement>('#ttlt');
      const ttlB = chapterHost.querySelector<HTMLElement>('#ttlB');

      expect(ttlt).not.toBeNull();
      expect(ttlt?.textContent?.trim()).toBe('2025–26');
      expect(ttlB).not.toBeNull();
      expect(ttlB?.textContent).toContain('2025–26');
      expect(ttlB?.textContent).not.toMatch(/\b2025 operating grid\b/);
    }

    player.destroy();
  });

  it('4 & 5. verifies adaptive 6-to-13 slide selection, sequential 01 / 0N kickers, and full 13-chapter B2B DOM & copy audit', () => {
    const { rootEl } = setupStoryPlayerTestDom('?byo=1');

    // A. Adaptive chapter count (6..13) and sequential kicker numbering on natural B2B datasets
    const naturalBundles: DatasetBundle[] = [
      ingestFilesDeterministically(
        [{ name: 'acme_cloud_fy2025.csv', content: SAMPLE_SAAS_B2B_CSV, mimeType: 'text/csv' }],
        { entityName: 'Acme Cloud Corp', isB2B: true }
      ),
      ingestFilesDeterministically(
        [
          {
            name: 'northbank_flagship_2025-26.csv',
            content: buildMultiYear2025To2026B2BCsv(),
            mimeType: 'text/csv',
          },
        ],
        { entityName: 'Northbank Coffee Roasters — Southbank Flagship', isB2B: true }
      ),
    ];

    const sampleDir = path.resolve(process.cwd(), '..', 'sample_b2b_data');
    const nimbusXlsxPath = path.join(sampleDir, 'nimbus_cloud_saas_fy2025.xlsx');
    if (fs.existsSync(nimbusXlsxPath)) {
      naturalBundles.push(
        ingestFilesDeterministically([
          {
            name: 'nimbus_cloud_saas_fy2025.xlsx',
            content: fs.readFileSync(nimbusXlsxPath).toString('base64'),
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            encoding: 'base64',
          },
        ])
      );
    }

    const northbankPath = path.resolve(
      process.cwd(),
      '..',
      '..',
      'knowledge_work',
      'sample_data_sheets',
      'northbank_coffee_2025-26.xlsx'
    );
    if (fs.existsSync(northbankPath)) {
      naturalBundles.push(
        ingestFilesDeterministically([
          {
            name: 'northbank_coffee_2025-26.xlsx',
            content: fs.readFileSync(northbankPath).toString('base64'),
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            encoding: 'base64',
          },
        ])
      );
    }

    for (const bundle of naturalBundles) {
      const total = bundle.plan.chapters.length;
      expect(total).toBeGreaterThanOrEqual(6);
      expect(total).toBeLessThanOrEqual(13);
      const totalStr = String(total).padStart(2, '0');
      bundle.plan.chapters.forEach((ch, idx) => {
        const expectedPrefix = `${String(idx + 1).padStart(2, '0')} / ${totalStr} · `;
        expect(ch.params.kicker?.startsWith(expectedPrefix)).toBe(true);
      });
    }

    // B. Force all 13 B2B chapters via selectedChapters and mount every single one (0..12) in StoryPlayer
    const forced13Bundle = ingestFilesDeterministically(
      [
        {
          name: 'northbank_flagship_2025-26.csv',
          content: buildMultiYear2025To2026B2BCsv(),
          mimeType: 'text/csv',
        },
      ],
      {
        entityName: 'Northbank Coffee Roasters — Southbank Flagship',
        isB2B: true,
        selectedChapters: [...ALL_13_B2B_CHAPTER_KEYS],
      }
    );

    expect(forced13Bundle.plan.chapters.length).toBe(13);

    const player = new StoryPlayer(rootEl, forced13Bundle);
    registerBespokeChapters(player);

    const datasetsToMountAudit: DatasetBundle[] = [forced13Bundle, ...naturalBundles];

    for (const bundle of datasetsToMountAudit) {
      player.loadDataset(bundle, true);
      const total = bundle.plan.chapters.length;
      const totalStr = String(total).padStart(2, '0');
      const chapterHost = rootEl.querySelector<HTMLElement>('#chapter-host')!;
      const chlEl = rootEl.querySelector<HTMLElement>('#chl')!;

      for (let i = 0; i < total; i++) {
        player.goToChapter(i);
        const ch = bundle.plan.chapters[i]!;
        const expectedPrefix = `${String(i + 1).padStart(2, '0')} / ${totalStr}`;

        expect(ch.params.kicker?.startsWith(`${expectedPrefix} · `)).toBe(true);
        expect(chlEl.textContent?.startsWith(`${expectedPrefix} · `)).toBe(true);

        const html = chapterHost.innerHTML;
        const text = chapterHost.textContent ?? '';

        // Verify zero occurrences of any forbidden consumer/typo copy across DOM & chrome
        for (const phrase of FORBIDDEN_B2B_COPY_PHRASES) {
          expect(html).not.toContain(phrase);
          expect(text).not.toContain(phrase);
          expect(chlEl.textContent ?? '').not.toContain(phrase);
        }

        // In shatter chapter: assert .num.gh does NOT exist (giant "505" ghost number is gone)
        if (ch.type === 'shatter') {
          expect(chapterHost.querySelector('.num.gh')).toBeNull();
        }

        // Assert every chapter with a header has .ch-header-stack containing headline and body
        const headerStack = chapterHost.querySelector<HTMLElement>('.ch-header-stack');
        expect(headerStack).not.toBeNull();
        expect(headerStack?.querySelector('[data-testid="chapter-headline"]')).not.toBeNull();
        expect(headerStack?.querySelector('[data-testid="chapter-body"]')).not.toBeNull();
      }
    }

    player.destroy();
  });

  it('6. verifies sample-ledger 8-transaction regression fixes for Pour stat cards, Explore category lenses, and ReceiptsDrawer totals', () => {
    const { rootEl } = setupStoryPlayerTestDom('?byo=1');
    const sampleLedgerCsv = [
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

    const bundle = ingestFilesDeterministically([
      {
        name: 'sample-ledger.csv',
        content: sampleLedgerCsv,
        mimeType: 'text/csv',
      },
    ]);

    expect(bundle.transactions).toHaveLength(8);

    const player = new StoryPlayer(rootEl, bundle);
    registerBespokeChapters(player);
    player.loadDataset(bundle, true);
    player.goToChapter(0);

    // Bug 1: Chapter 01 (pour) stat cards match money & entry count facts (defaulting to NGN ₦)
    const chapterHost = rootEl.querySelector<HTMLElement>('#chapter-host')!;
    const spendBlock = chapterHost.querySelector<HTMLElement>('[data-testid="metric-block-spend"]');
    const inflowBlock = chapterHost.querySelector<HTMLElement>('[data-testid="metric-block-count"]');
    const reconciledBlock = chapterHost.querySelector<HTMLElement>(
      '[data-testid="metric-block-paydays"]'
    );

    expect(spendBlock?.textContent).toContain('₦');
    expect(spendBlock?.textContent).toContain('212,000');
    expect(inflowBlock?.textContent).toContain('Gross Operating Inflow');
    expect(inflowBlock?.textContent).toContain('₦');
    expect(inflowBlock?.textContent).toContain('310,000');
    expect(reconciledBlock?.textContent).toContain('Ledger Entries Reconciled');
    expect(reconciledBlock?.textContent).toContain('8');
    expect(reconciledBlock?.textContent).not.toContain('₦');

    // Bug 2: Explore lenses keep FOOD (₦80,000 / 2 purchases) isolated from HOUSING (₦85,000 / 1 purchase)
    player.openExplore();
    const chips = Array.from(rootEl.querySelectorAll<HTMLButtonElement>('#chips .chip'));
    const findChip = (label: string) =>
      chips.find((c) => c.dataset.displayLabel?.toUpperCase() === label.toUpperCase());

    const foodChip = findChip('FOOD');
    const housingChip = findChip('HOUSING');
    const utilitiesChip = findChip('UTILITIES');
    const transportChip = findChip('TRANSPORT');

    expect(foodChip).toBeDefined();
    expect(housingChip).toBeDefined();
    expect(utilitiesChip).toBeDefined();
    expect(transportChip).toBeDefined();

    const exday = rootEl.querySelector<HTMLElement>('#exday')!;
    const exdet = rootEl.querySelector<HTMLElement>('#exdet')!;

    foodChip!.click();
    expect(exday.textContent).toContain('₦80,000');
    expect(exdet.textContent).toContain('2 purchases');

    housingChip!.click();
    expect(exday.textContent).toContain('₦85,000');
    expect(exdet.textContent).toContain('1 purchase');

    utilitiesChip!.click();
    expect(exday.textContent).toContain('₦32,000');
    expect(exdet.textContent).toContain('2 purchases');

    transportChip!.click();
    expect(exday.textContent).toContain('₦15,000');
    expect(exdet.textContent).toContain('1 purchase');

    // Bug 3: ReceiptsDrawer shows matching count, labels, and totals for mixed, outflow-only, inflow-only, and filtered lists
    const allIds = bundle.transactions.map((t) => t.id);
    player.openReceipts('Operating Outflow & Ledger Summary', allIds);
    const summaryBar = rootEl.querySelector<HTMLElement>('#receipts-summary-bar')!;
    const receiptItems = rootEl.querySelectorAll('#receipts-list .receipt-item');
    expect(receiptItems).toHaveLength(8);
    expect(summaryBar.textContent).toContain('8 TRANSACTIONS (2 IN · 6 OUT)');
    expect(summaryBar.textContent).toContain('NET +₦98,000.00');
    expect(summaryBar.textContent).toContain('+₦310,000.00 IN');
    expect(summaryBar.textContent).toContain('-₦212,000.00 OUT');

    // Search filtering inside mixed ReceiptsDrawer updates both count and total dynamically
    const searchInput = rootEl.querySelector<HTMLInputElement>('#receipts-search')!;
    searchInput.value = 'Market';
    searchInput.dispatchEvent({ type: 'input' } as unknown as Event);
    expect(rootEl.querySelectorAll('#receipts-list .receipt-item')).toHaveLength(2);
    expect(summaryBar.textContent).toContain('2 OF 8 TRANSACTIONS · OUTFLOWS');
    expect(summaryBar.textContent).toContain('₦80,000.00');

    // Outflow-only list
    const outIds = bundle.transactions.filter((t) => t.direction === 'out').map((t) => t.id);
    player.openReceipts('All 2025 Purchases', outIds);
    expect(rootEl.querySelectorAll('#receipts-list .receipt-item')).toHaveLength(6);
    expect(rootEl.querySelector('#receipts-summary-bar')?.textContent).toContain(
      '6 TRANSACTIONS · OUTFLOWS'
    );
    expect(rootEl.querySelector('#receipts-summary-bar')?.textContent).toContain('₦212,000.00');

    // Inflow-only list
    const inIds = bundle.transactions.filter((t) => t.direction === 'in').map((t) => t.id);
    player.openReceipts('Operating Inflows', inIds);
    expect(rootEl.querySelectorAll('#receipts-list .receipt-item')).toHaveLength(2);
    expect(rootEl.querySelector('#receipts-summary-bar')?.textContent).toContain(
      '2 TRANSACTIONS · INFLOWS'
    );
    expect(rootEl.querySelector('#receipts-summary-bar')?.textContent).toContain('+₦310,000.00');

    // Switching currency to USD updates receipts & explore amounts without altering numbers
    player.setCurrencyCode('USD');
    expect(rootEl.querySelector('#receipts-summary-bar')?.textContent).toContain('+$310,000.00');
    player.receiptsDrawer.close();
    expect(rootEl.querySelector<HTMLElement>('#exday')?.textContent).toContain('$15,000');
    player.setCurrencyCode('NGN');

    // Edge case: two distinct custom labels mapped to the same canonical slot remain isolated in Explore
    const sameSlotCsv = [
      'Date,Description,Category,Amount',
      '2025-02-01,Client Revenue,INCOME,100000',
      '2025-02-02,Farm Produce Co,FOOD,-30000',
      '2025-02-03,Corner Grocer,GROCERIES,-12000',
    ].join('\n');
    const sameSlotBundle = ingestFilesDeterministically([
      { name: 'same-slot.csv', content: sameSlotCsv, mimeType: 'text/csv' },
    ]);
    player.loadDataset(sameSlotBundle, true);
    player.openExplore();
    const slotChips = Array.from(rootEl.querySelectorAll<HTMLButtonElement>('#chips .chip'));
    const slotFoodChip = slotChips.find((c) => c.dataset.displayLabel?.toUpperCase() === 'FOOD');
    const slotGroceriesChip = slotChips.find(
      (c) => c.dataset.displayLabel?.toUpperCase() === 'GROCERIES'
    );
    expect(slotFoodChip).toBeDefined();
    expect(slotGroceriesChip).toBeDefined();
    slotFoodChip!.click();
    expect(rootEl.querySelector<HTMLElement>('#exday')?.textContent).toContain('₦30,000');
    expect(rootEl.querySelector<HTMLElement>('#exdet')?.textContent).toContain('1 purchase');
    slotGroceriesChip!.click();
    expect(rootEl.querySelector<HTMLElement>('#exday')?.textContent).toContain('₦12,000');
    expect(rootEl.querySelector<HTMLElement>('#exdet')?.textContent).toContain('1 purchase');

    player.destroy();
  });
});

