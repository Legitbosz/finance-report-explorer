import { formatMoneyMinor, type Fact } from '../../contracts/index.js';

export const CURRENCY_STORAGE_KEY = 'finance_story_currency_v1';

export type CurrencyCode =
  | 'NGN'
  | 'USD'
  | 'GBP'
  | 'EUR'
  | 'GHS'
  | 'KES'
  | 'ZAR'
  | 'CAD'
  | 'AUD'
  | 'INR'
  | 'JPY';

export interface CurrencyOption {
  code: CurrencyCode;
  symbol: string;
  badge: string;
  label: string;
  name: string;
}

export const CURRENCY_OPTIONS: readonly CurrencyOption[] = [
  { code: 'NGN', symbol: '₦', badge: '₦', label: 'NGN (₦)', name: 'Nigerian Naira' },
  { code: 'USD', symbol: '$', badge: '$', label: 'USD ($)', name: 'US Dollar' },
  { code: 'GBP', symbol: '£', badge: '£', label: 'GBP (£)', name: 'British Pound' },
  { code: 'EUR', symbol: '€', badge: '€', label: 'EUR (€)', name: 'Euro' },
  { code: 'GHS', symbol: '₵', badge: '₵', label: 'GHS (₵)', name: 'Ghanaian Cedi' },
  { code: 'KES', symbol: 'KSh ', badge: 'KSh', label: 'KES (KSh)', name: 'Kenyan Shilling' },
  { code: 'ZAR', symbol: 'R', badge: 'R', label: 'ZAR (R)', name: 'South African Rand' },
  { code: 'CAD', symbol: 'CA$', badge: 'CA$', label: 'CAD (CA$)', name: 'Canadian Dollar' },
  { code: 'AUD', symbol: 'A$', badge: 'A$', label: 'AUD (A$)', name: 'Australian Dollar' },
  { code: 'INR', symbol: '₹', badge: '₹', label: 'INR (₹)', name: 'Indian Rupee' },
  { code: 'JPY', symbol: '¥', badge: '¥', label: 'JPY (¥)', name: 'Japanese Yen' },
] as const;

export const DEFAULT_CURRENCY_CODE: CurrencyCode = 'NGN';

const CURRENCY_BY_CODE = new Map<string, CurrencyOption>(
  CURRENCY_OPTIONS.map((opt) => [opt.code, opt])
);

export interface CurrencyStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveCurrencyStorage(override?: CurrencyStorageLike | null): CurrencyStorageLike | null {
  if (override !== undefined) return override;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore restricted storage environments
  }
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      const ls = (globalThis as unknown as { localStorage?: CurrencyStorageLike }).localStorage;
      if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
        return ls;
      }
    }
  } catch {
    // Ignore restricted storage environments
  }
  return null;
}

export function normalizeCurrencyCode(raw: string | null | undefined): CurrencyCode {
  const upper = (raw ?? '').trim().toUpperCase();
  if (CURRENCY_BY_CODE.has(upper)) {
    return upper as CurrencyCode;
  }
  return DEFAULT_CURRENCY_CODE;
}

export function getCurrencyOption(code: CurrencyCode | string): CurrencyOption {
  return (
    CURRENCY_BY_CODE.get(normalizeCurrencyCode(code)) ??
    CURRENCY_BY_CODE.get(DEFAULT_CURRENCY_CODE)!
  );
}

export function getCurrencySymbol(code: CurrencyCode | string): string {
  return getCurrencyOption(code).symbol;
}

export function loadSavedCurrencyCode(storageOverride?: CurrencyStorageLike | null): CurrencyCode {
  const storage = resolveCurrencyStorage(storageOverride);
  if (!storage) return DEFAULT_CURRENCY_CODE;
  try {
    const raw = storage.getItem(CURRENCY_STORAGE_KEY);
    return normalizeCurrencyCode(raw);
  } catch {
    return DEFAULT_CURRENCY_CODE;
  }
}

export function saveCurrencyCode(
  code: string,
  storageOverride?: CurrencyStorageLike | null
): CurrencyCode {
  const normalized = normalizeCurrencyCode(code);
  const storage = resolveCurrencyStorage(storageOverride);
  if (storage) {
    try {
      storage.setItem(CURRENCY_STORAGE_KEY, normalized);
    } catch {
      // Ignore storage write errors cleanly
    }
  }
  return normalized;
}

const CURRENCY_PREFIX_RE =
  /^([+-]?)(?:US\$|CA\$|A\$|KSh\s*|CHF\s*|NGN\s*|GHS\s*|USD\s*|GBP\s*|EUR\s*|₦|\$|£|€|₵|₹|¥|R(?=\d))/;

const STANDALONE_CURRENCY_SUP_RE =
  /^(?:US\$|CA\$|A\$|KSh|CHF|NGN|GHS|USD|GBP|EUR|₦|\$|£|€|₵|₹|¥|R)$/i;

export function isCurrencyUnitSup(unitSup: string | undefined): boolean {
  if (!unitSup) return false;
  return STANDALONE_CURRENCY_SUP_RE.test(unitSup.trim());
}

export function hasCurrencyPrefix(formatted: string): boolean {
  return CURRENCY_PREFIX_RE.test(formatted.trim());
}

export function stripCurrencyPrefix(formatted: string): string {
  return formatted.trim().replace(CURRENCY_PREFIX_RE, '$1');
}

export function formatMoneyWithSymbol(
  amountMinor: number,
  symbol: string,
  options: { showCents?: boolean; showPositiveSign?: boolean } = {}
): string {
  const rounded = Math.round(amountMinor);
  const sign = rounded < 0 ? '-' : options.showPositiveSign && rounded > 0 ? '+' : '';
  const digits = formatMoneyMinor(Math.abs(rounded), {
    showCents: options.showCents,
    prefix: '',
  });
  return `${sign}${symbol}${digits}`;
}

export function rewriteFactFormattedForCurrency(fact: Fact, symbol: string): Fact {
  const isMonetaryUnit = fact.unit === 'usd' || fact.unit === 'usd_cents';
  if (!isMonetaryUnit && !hasCurrencyPrefix(fact.formatted)) {
    return fact;
  }
  const match = CURRENCY_PREFIX_RE.exec(fact.formatted.trim());
  if (!match) {
    if (isMonetaryUnit && /^[+-]?\d/.test(fact.formatted.trim())) {
      const trimmed = fact.formatted.trim();
      const sign = trimmed.startsWith('-') || trimmed.startsWith('+') ? trimmed[0]! : '';
      const digits = sign ? trimmed.slice(1) : trimmed;
      return {
        ...fact,
        formatted: `${sign}${symbol}${digits}`,
      };
    }
    return fact;
  }
  const sign = match[1] ?? '';
  const rest = fact.formatted.trim().slice(match[0].length);
  return {
    ...fact,
    formatted: `${sign}${symbol}${rest}`,
  };
}
