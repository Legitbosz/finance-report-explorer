import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { RawIngestFile } from '../../contracts/index.js';

let workerConfigured = false;

function ensurePdfWorkerConfigured(): void {
  if (workerConfigured) return;
  workerConfigured = true;
  if (typeof window !== 'undefined' && pdfWorkerUrl) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
}

interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

const MONTH_MAP: Record<string, string> = {
  jan: '01',
  january: '01',
  feb: '02',
  february: '02',
  mar: '03',
  march: '03',
  apr: '04',
  april: '04',
  may: '05',
  jun: '06',
  june: '06',
  jul: '07',
  july: '07',
  aug: '08',
  august: '08',
  sep: '09',
  sept: '09',
  september: '09',
  oct: '10',
  october: '10',
  nov: '11',
  november: '11',
  dec: '12',
  december: '12',
};

function escapeCsvCell(val: string): string {
  if (/[",\n\r]/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function inferDocumentYear(lines: readonly string[]): string {
  for (const line of lines.slice(0, 30)) {
    const match = /\b(20[1-3]\d)\b/.exec(line);
    if (match) return match[1]!;
  }
  return String(new Date().getFullYear());
}

function normalizePdfDateToken(raw: string, fallbackYear: string): string | null {
  const s = raw.trim();
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (iso) {
    const m = Number.parseInt(iso[2]!, 10);
    const d = Number.parseInt(iso[3]!, 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${iso[1]}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const slashFull = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (slashFull) {
    const p1 = Number.parseInt(slashFull[1]!, 10);
    const p2 = Number.parseInt(slashFull[2]!, 10);
    const rawY = slashFull[3]!;
    const y = rawY.length === 2 ? `20${rawY}` : rawY;
    const m = p1 > 12 && p2 <= 12 ? p2 : p1;
    const d = p1 > 12 && p2 <= 12 ? p1 : p2;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const slashShort = /^(\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (slashShort) {
    const p1 = Number.parseInt(slashShort[1]!, 10);
    const p2 = Number.parseInt(slashShort[2]!, 10);
    const m = p1 > 12 && p2 <= 12 ? p2 : p1;
    const d = p1 > 12 && p2 <= 12 ? p1 : p2;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${fallbackYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const namedFirst =
    /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(s);
  if (namedFirst) {
    const m = MONTH_MAP[namedFirst[1]!.toLowerCase()];
    const d = Number.parseInt(namedFirst[2]!, 10);
    const y = namedFirst[3] ?? fallbackYear;
    if (m && d >= 1 && d <= 31) {
      return `${y}-${m}-${String(d).padStart(2, '0')}`;
    }
  }

  const dayFirst =
    /^(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:\s+(\d{4}))?$/.exec(s);
  if (dayFirst) {
    const d = Number.parseInt(dayFirst[1]!, 10);
    const m = MONTH_MAP[dayFirst[2]!.toLowerCase()];
    const y = dayFirst[3] ?? fallbackYear;
    if (m && d >= 1 && d <= 31) {
      return `${y}-${m}-${String(d).padStart(2, '0')}`;
    }
  }

  return null;
}

interface ParsedAmountToken {
  amount: number;
  raw: string;
  explicitCredit: boolean;
  explicitDebit: boolean;
  currency: string;
}

function parseAmountToken(raw: string): ParsedAmountToken | null {
  const s = raw.trim();
  if (!s) return null;
  const currency = s.includes('€')
    ? 'EUR'
    : s.includes('£')
      ? 'GBP'
      : 'USD';
  const isParen = /^\(.*\)$/.test(s);
  const explicitCredit = /\bCR\b/i.test(s) || s.startsWith('+');
  const explicitDebit = /\bDR\b/i.test(s) || isParen || s.startsWith('-');
  const cleaned = s.replace(/[^0-9.-]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const num = Number.parseFloat(cleaned);
  if (Number.isNaN(num) || num === 0) return null;
  return {
    amount: isParen ? -Math.abs(num) : num,
    raw: s,
    explicitCredit,
    explicitDebit,
    currency,
  };
}

const SKIP_SUMMARY_LINE_RE =
  /^(?:opening|closing|beginning|ending|previous|starting|new|statement|ledger)\s+balance\b|\btotal\s+(?:deposits|withdrawals|credits|debits|charges|payments|fees|balance)\b|\bpage\s+\d+\s+of\s+\d+\b|\baccount\s+(?:summary|number)\b/i;

const DATE_PREFIX_RE =
  /^(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/.]\d{1,2}(?:[-/.]\d{2,4})?|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\s+[A-Za-z]{3,9}\.?(?:\s+\d{4})?)\s+(.+)$/;

const AMOUNT_TOKEN_RE =
  /(?:[+-]?\s*(?:\(\s*)?(?:US\$|CA\$|AU\$|\$|€|£)?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})|\(\s*(?:US\$|CA\$|AU\$|\$|€|£)?\s*\d+(?:\.\d{2})\s*\))(?:\s*(?:CR|DR))?/gi;

export interface ExtractedPdfRow {
  date: string;
  description: string;
  amount: string;
  account: string;
  tran_type: string;
  currency: string;
}

/**
 * Parses reconstructed text lines from a financial PDF statement/ledger
 * into normalized transaction rows purely deterministically.
 */
export function extractFinancialRowsFromPdfLines(lines: readonly string[]): ExtractedPdfRow[] {
  const fallbackYear = inferDocumentYear(lines);
  const rows: ExtractedPdfRow[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line || line.length < 8) continue;
    if (SKIP_SUMMARY_LINE_RE.test(line)) continue;

    const dateMatch = DATE_PREFIX_RE.exec(line);
    if (!dateMatch) continue;

    const isoDate = normalizePdfDateToken(dateMatch[1]!, fallbackYear);
    if (!isoDate) continue;

    let remainder = dateMatch[2]!.trim();
    // Some bank statements print a second posting date right after the transaction date
    const secondDateMatch = DATE_PREFIX_RE.exec(remainder);
    if (secondDateMatch && normalizePdfDateToken(secondDateMatch[1]!, fallbackYear)) {
      remainder = secondDateMatch[2]!.trim();
    }

    const amountMatches = Array.from(remainder.matchAll(AMOUNT_TOKEN_RE));
    if (amountMatches.length === 0) continue;

    // If a statement row includes both [Transaction Amount] and [Running Balance],
    // use the transaction amount (penultimate match) rather than the running balance.
    const chosenMatch =
      amountMatches.length >= 2
        ? amountMatches[amountMatches.length - 2]!
        : amountMatches[amountMatches.length - 1]!;

    const parsedAmt = parseAmountToken(chosenMatch[0]);
    if (!parsedAmt) continue;

    const firstAmtIdx = amountMatches[0]!.index ?? remainder.length;
    const description = remainder
      .slice(0, firstAmtIdx)
      .replace(/[\s|•·-]+$/, '')
      .trim();

    if (!description || description.length < 2) continue;
    if (SKIP_SUMMARY_LINE_RE.test(description)) continue;

    let signedAmount = parsedAmt.amount;
    if (parsedAmt.explicitDebit) {
      signedAmount = -Math.abs(signedAmount);
    } else if (parsedAmt.explicitCredit) {
      signedAmount = Math.abs(signedAmount);
    } else if (signedAmount > 0) {
      const isInflow =
        /\b(deposit|credit|payroll|direct\s+dep|salary|revenue|income|inflow|settlement|payout|refund|interest\s+earned|dividend|client\s+payment|arr)\b/i.test(
          description
        );
      signedAmount = isInflow ? Math.abs(signedAmount) : -Math.abs(signedAmount);
    }

    rows.push({
      date: isoDate,
      description,
      amount: signedAmount.toFixed(2),
      account: 'PDF Statement',
      tran_type: signedAmount >= 0 ? 'CREDIT' : 'DEBIT',
      currency: parsedAmt.currency,
    });
  }

  return rows;
}

function reconstructLinesFromItems(items: readonly PositionedTextItem[]): string[] {
  if (items.length === 0) return [];
  const sorted = items
    .slice()
    .sort((a, b) => (Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x));

  const lineBuckets: PositionedTextItem[][] = [];
  for (const item of sorted) {
    const lastBucket = lineBuckets[lineBuckets.length - 1];
    if (!lastBucket || Math.abs(lastBucket[0]!.y - item.y) > 3.5) {
      lineBuckets.push([item]);
    } else {
      lastBucket.push(item);
    }
  }

  return lineBuckets.map((bucket) => {
    bucket.sort((a, b) => a.x - b.x);
    let line = '';
    let prevEnd = -Infinity;
    for (const part of bucket) {
      if (line.length > 0 && part.x - prevEnd > 2) {
        line += ' ';
      }
      line += part.str;
      prevEnd = part.x + part.width;
    }
    return line.trim();
  });
}

/**
 * Extracts transaction rows from a local PDF buffer in the browser using `pdfjs-dist`
 * and converts them into a UTF-8 CSV `RawIngestFile` so no data ever leaves the device.
 */
export async function parsePdfBufferToCsvIngestFile(
  bytes: Uint8Array,
  fileName: string
): Promise<RawIngestFile> {
  ensurePdfWorkerConfigured();

  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    useWorkerFetch: false,
    disableFontFace: true,
  });

  const pdfDoc = await loadingTask.promise;
  const allLines: string[] = [];

  try {
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const positioned: PositionedTextItem[] = [];

      for (const rawItem of textContent.items) {
        if (
          typeof rawItem === 'object' &&
          rawItem !== null &&
          'str' in rawItem &&
          'transform' in rawItem
        ) {
          const str = String(rawItem.str ?? '').trim();
          if (!str) continue;
          const transform = rawItem.transform as number[];
          positioned.push({
            str,
            x: Number(transform[4] ?? 0),
            y: Number(transform[5] ?? 0),
            width: Number('width' in rawItem ? rawItem.width : 0),
          });
        }
      }

      allLines.push(...reconstructLinesFromItems(positioned));
    }
  } finally {
    await loadingTask.destroy();
  }

  const rows = extractFinancialRowsFromPdfLines(allLines);
  if (rows.length === 0) {
    throw new Error(
      `No financial transactions could be extracted locally from "${fileName}". Ensure the PDF contains selectable text (scanned image-only PDFs require CSV or Excel export).`
    );
  }

  const csvLines = [
    'date,description,amount,account,tran_type,currency',
    ...rows.map((r) =>
      [
        escapeCsvCell(r.date),
        escapeCsvCell(r.description),
        escapeCsvCell(r.amount),
        escapeCsvCell(r.account),
        escapeCsvCell(r.tran_type),
        escapeCsvCell(r.currency),
      ].join(',')
    ),
  ];

  return {
    name: fileName.replace(/\.pdf$/i, '') + '.csv',
    mimeType: 'text/csv',
    content: csvLines.join('\n'),
    encoding: 'utf8',
  };
}
