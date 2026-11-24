import {
  type Category,
  type DatasetBundle,
  type IngestProgressStep,
  type RawIngestFile,
  type RawSourceRow,
} from '../../contracts/index.js';
import {
  buildDatasetBundleFromRows,
  ingestFilesDeterministically,
} from '../../pipeline/ingest-business.js';
import { parseCsvLine } from '../../pipeline/parse.js';
import { convertXlsxToCsvIngestFiles, isXlsxBytes } from '../../pipeline/xlsx.js';
import { parsePdfBufferToCsvIngestFile } from './pdf-parser.js';

function inferMimeType(fileName: string, rawType?: string): string {
  if (rawType && rawType.trim().length > 0) return rawType.trim();
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.tsv')) return 'text/tab-separated-values';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.txt') || lower.endsWith('.log') || lower.endsWith('.md')) {
    return 'text/plain';
  }
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

function isTextFile(fileName: string, mimeType: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.pdf')) {
    return false;
  }
  if (
    lower.endsWith('.csv') ||
    lower.endsWith('.tsv') ||
    lower.endsWith('.json') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.log') ||
    lower.endsWith('.md')
  ) {
    return true;
  }
  return (
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('csv') ||
    mimeType.includes('tab-separated')
  );
}

/**
 * Reads and parses browser `FileList` or `File[]` 100% locally in the browser:
 * - `.xlsx`/`.xls` Excel workbooks are unpacked locally into CSV tab files
 * - `.pdf` statements are parsed locally via `pdfjs-dist` into CSV rows
 * - `.csv`, `.tsv`, `.json`, `.txt` are read locally as UTF-8 text
 * No file bytes ever leave the user's computer.
 */
export async function readBrowserFiles(fileList: FileList | File[]): Promise<RawIngestFile[]> {
  const files = Array.from(fileList);
  const results: RawIngestFile[] = [];

  for (const file of files) {
    const mimeType = inferMimeType(file.name, file.type);
    const lowerName = file.name.toLowerCase();

    if (
      lowerName.endsWith('.xlsx') ||
      lowerName.endsWith('.xls') ||
      /spreadsheetml|excel/i.test(mimeType)
    ) {
      const buffer = await file.arrayBuffer();
      const u8 = new Uint8Array(buffer);
      if (!isXlsxBytes(u8)) {
        throw new Error(
          `"${file.name}" does not appear to be a valid .xlsx OpenXML workbook. Please save as .xlsx or .csv and try again.`
        );
      }
      const converted = convertXlsxToCsvIngestFiles(u8, file.name);
      if (converted.files.length === 0) {
        throw new Error(`No readable sheets were found in "${file.name}".`);
      }
      results.push(...converted.files);
    } else if (lowerName.endsWith('.pdf') || mimeType === 'application/pdf') {
      const buffer = await file.arrayBuffer();
      const u8 = new Uint8Array(buffer);
      const csvFile = await parsePdfBufferToCsvIngestFile(u8, file.name);
      results.push(csvFile);
    } else if (isTextFile(file.name, mimeType)) {
      const content =
        typeof file.text === 'function' ? await file.text() : await readFileAsTextFallback(file);
      results.push({
        name: file.name,
        mimeType,
        content,
        encoding: 'utf8',
      });
    } else {
      throw new Error(
        `Unsupported file type for "${file.name}". Please upload Excel (.xlsx), CSV, JSON, or PDF files.`
      );
    }
  }

  return results;
}

function readFileAsTextFallback(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function normalizeFlexibleIsoDate(raw: string, fallbackIdx: number): string {
  const s = raw.trim();
  const isoMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (isoMatch) {
    const y = isoMatch[1]!;
    const m = isoMatch[2]!.padStart(2, '0');
    const d = isoMatch[3]!.padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const usMatch = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
  if (usMatch) {
    const p1 = Number.parseInt(usMatch[1]!, 10);
    const p2 = Number.parseInt(usMatch[2]!, 10);
    const mNum = p1 > 12 && p2 <= 12 ? p2 : p1;
    const dNum = p1 > 12 && p2 <= 12 ? p1 : p2;
    const m = String(Math.max(1, Math.min(12, mNum))).padStart(2, '0');
    const d = String(Math.max(1, Math.min(31, dNum))).padStart(2, '0');
    const y = usMatch[3]!;
    return `${y}-${m}-${d}`;
  }
  const ymMatch = /^(\d{4})[-/](\d{1,2})$/.exec(s);
  if (ymMatch) {
    return `${ymMatch[1]}-${ymMatch[2]!.padStart(2, '0')}-15`;
  }
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    const dt = new Date(parsed);
    const y = dt.getUTCFullYear();
    if (y >= 2000 && y <= 2035) {
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dt.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }
  const dayOfYear = (fallbackIdx % 365) + 1;
  const dt = new Date(Date.UTC(2025, 0, dayOfYear));
  return dt.toISOString().slice(0, 10);
}

function cleanAmountString(raw: string): number {
  const s = raw.trim();
  if (!s) return NaN;
  const isParenNegative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[^0-9.-]/g, '');
  const num = Number.parseFloat(cleaned);
  if (Number.isNaN(num)) return NaN;
  return isParenNegative ? -Math.abs(num) : num;
}

/**
 * Universal fallback tabular parser for arbitrary business CSVs, TSVs, and JSON dumps
 * whose headers differ from standard retail bank exports.
 */
export function parseFlexibleTabularRows(files: readonly RawIngestFile[]): RawSourceRow[] {
  const rows: RawSourceRow[] = [];
  let rowCounter = 1;

  for (const file of files) {
    if (!file.content || file.encoding === 'base64') continue;
    const trimmed = file.content.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const arr = Array.isArray(parsed)
          ? parsed
          : typeof parsed === 'object' && parsed !== null
            ? ((parsed as Record<string, unknown>).transactions ??
              (parsed as Record<string, unknown>).rows ??
              (parsed as Record<string, unknown>).data ??
              [])
            : [];
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (typeof item !== 'object' || item === null) continue;
            const rec = item as Record<string, unknown>;
            const rawDate = String(
              rec.date ??
                rec.transaction_date ??
                rec.posted_date ??
                rec.period ??
                rec.timestamp ??
                rec.month ??
                ''
            );
            const rawDesc = String(
              rec.description ??
                rec.merchant ??
                rec.vendor ??
                rec.counterparty ??
                rec.name ??
                rec.payee ??
                rec.account_name ??
                rec.memo ??
                rec.category ??
                'Business Transaction'
            );
            const rawType = String(
              rec.tran_type ?? rec.type ?? rec.category ?? rec.department ?? 'OPERATING'
            );
            const rawAcct = String(rec.account ?? rec.cost_center ?? 'Operating Ledger');
            const rawCurr = String(rec.currency ?? 'USD');

            let numericAmt = NaN;
            if (rec.amount !== undefined) {
              numericAmt = cleanAmountString(String(rec.amount));
            } else if (rec.amount_minor !== undefined) {
              numericAmt = Number(rec.amount_minor) / 100;
              if (rec.direction === 'out' && numericAmt > 0) numericAmt = -numericAmt;
            } else if (rec.debit !== undefined || rec.credit !== undefined) {
              const deb = cleanAmountString(String(rec.debit ?? '0')) || 0;
              const cred = cleanAmountString(String(rec.credit ?? '0')) || 0;
              numericAmt = cred > 0 ? cred : -Math.abs(deb);
            } else if (
              rec.total !== undefined ||
              rec.value !== undefined ||
              rec.spend !== undefined
            ) {
              numericAmt = cleanAmountString(String(rec.total ?? rec.value ?? rec.spend));
            }

            if (Number.isNaN(numericAmt) || numericAmt === 0) continue;
            const dirHint = String(rec.direction ?? rec.type ?? '').toLowerCase();
            if (
              numericAmt > 0 &&
              !/\b(in|income|revenue|credit|deposit|inflow|sales|arr)\b/.test(dirHint) &&
              !/\b(revenue|income|inflow|stripe\s+payout|customer|client\s+payment|arr)\b/i.test(
                rawDesc
              )
            ) {
              numericAmt = -Math.abs(numericAmt);
            }

            const isoDate = normalizeFlexibleIsoDate(rawDate, rowCounter);
            rows.push({
              id: String(rec.id ?? `BYO-${String(rowCounter).padStart(4, '0')}`),
              date: isoDate,
              posted_date: isoDate,
              account: rawAcct,
              tran_type: rawType,
              description: rawDesc,
              amount: numericAmt.toFixed(2),
              currency: rawCurr,
            });
            rowCounter++;
          }
          continue;
        }
      } catch {
        // Fall through to CSV/TSV line parsing
      }
    }

    const lines = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length < 2) continue;

    const delimiter = lines[0]!.includes('\t') && !lines[0]!.includes(',') ? '\t' : ',';
    const splitLine = (line: string): string[] =>
      delimiter === '\t' ? line.split('\t').map((c) => c.trim()) : parseCsvLine(line);

    const headers = splitLine(lines[0]!).map((h) =>
      h
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
    );

    const dateCol = headers.findIndex(
      (h) =>
        /^(date|txn_date|transaction_date|posted_date|booking_date|period|month|day|timestamp)$/.test(
          h
        ) || h.includes('date')
    );
    const descCol = headers.findIndex((h) =>
      /^(description|merchant|vendor|counterparty|payee|name|memo|narrative|details|line_item|account_name|particulars)$/.test(
        h
      )
    );
    const catCol = headers.findIndex((h) =>
      /^(category|department|cost_center|gl_account|type|tran_type|class|segment)$/.test(h)
    );
    const amtCol = headers.findIndex(
      (h) =>
        /^(amount|amount_usd|total|value|net|spend|cost|usd|sum|balance_change)$/.test(h) ||
        h.includes('amount')
    );
    const debitCol = headers.findIndex((h) =>
      /^(debit|outflow|withdrawal|expense|charge)$/.test(h)
    );
    const creditCol = headers.findIndex((h) => /^(credit|inflow|deposit|revenue|income)$/.test(h));
    const dirCol = headers.findIndex((h) => /^(direction|dr_cr|sign|flow)$/.test(h));
    const idCol = headers.findIndex((h) =>
      /^(id|txn_id|transaction_id|unique_id|reference|ref)$/.test(h)
    );
    const acctCol = headers.findIndex((h) => /^(account|bank_account|card|source)$/.test(h));
    const currCol = headers.findIndex((h) => /^(currency|curr|ccy)$/.test(h));

    for (let i = 1; i < lines.length; i++) {
      const cols = splitLine(lines[i]!);
      if (cols.length < 2) continue;

      const rawDate = dateCol >= 0 ? (cols[dateCol] ?? '') : (cols[0] ?? '');
      const rawDesc =
        descCol >= 0
          ? (cols[descCol] ?? '')
          : catCol >= 0
            ? (cols[catCol] ?? '')
            : (cols[1] ?? 'Operating Entry');
      const rawCat = catCol >= 0 ? (cols[catCol] ?? '') : '';
      const combinedDesc =
        rawCat && !rawDesc.toLowerCase().includes(rawCat.toLowerCase())
          ? `${rawDesc.trim()} (${rawCat.trim()})`
          : rawDesc.trim();

      let numericAmt = NaN;
      if (amtCol >= 0 && cols[amtCol] !== undefined) {
        numericAmt = cleanAmountString(cols[amtCol]!);
      } else if (debitCol >= 0 || creditCol >= 0) {
        const deb = debitCol >= 0 ? cleanAmountString(cols[debitCol] ?? '') || 0 : 0;
        const cred = creditCol >= 0 ? cleanAmountString(cols[creditCol] ?? '') || 0 : 0;
        if (cred !== 0 || deb !== 0) {
          numericAmt = cred > 0 ? Math.abs(cred) : -Math.abs(deb);
        }
      } else {
        for (let c = cols.length - 1; c >= 1; c--) {
          if (c === dateCol || c === idCol) continue;
          const candidate = cleanAmountString(cols[c] ?? '');
          if (!Number.isNaN(candidate) && candidate !== 0) {
            numericAmt = candidate;
            break;
          }
        }
      }

      if (Number.isNaN(numericAmt) || numericAmt === 0) continue;

      const dirHint = `${dirCol >= 0 ? (cols[dirCol] ?? '') : ''} ${rawCat}`.toLowerCase();
      if (
        numericAmt > 0 &&
        !/\b(in|income|revenue|credit|cr|deposit|inflow|sales|arr|receipt)\b/.test(dirHint) &&
        !/\b(revenue|income|inflow|payout|customer|client\s+payment|salary|arr|deposit)\b/i.test(
          combinedDesc
        )
      ) {
        numericAmt = -Math.abs(numericAmt);
      }

      const isoDate = normalizeFlexibleIsoDate(rawDate, rowCounter);
      const id =
        idCol >= 0 && cols[idCol]?.trim()
          ? cols[idCol]!.trim()
          : `BYO-${String(rowCounter).padStart(4, '0')}`;

      rows.push({
        id,
        date: isoDate,
        posted_date: isoDate,
        account: acctCol >= 0 && cols[acctCol]?.trim() ? cols[acctCol]!.trim() : 'Operating Ledger',
        tran_type: rawCat || 'OPERATING',
        description: combinedDesc || 'Operating Entry',
        amount: numericAmt.toFixed(2),
        currency: currCol >= 0 && cols[currCol]?.trim() ? cols[currCol]!.trim() : 'USD',
      });
      rowCounter++;
    }
  }

  return rows;
}

/**
 * Orchestrates 100% local, offline, client-only ledger ingestion:
 * - Parses Excel (.xlsx), CSV, TSV, JSON, or PDF files locally in the browser
 * - Profiles counterparties, fiscal calendar, 365-day grid, and `Fact[]`
 * - Builds and verifies the interactive Finance Story `DatasetBundle` with zero network calls
 */
export async function processByoIngestion(params: {
  files: RawIngestFile[];
  entityNameHint?: string;
  onProgress?: (step: IngestProgressStep) => void;
}): Promise<DatasetBundle> {
  const { files, entityNameHint, onProgress } = params;
  if (!files || files.length === 0) {
    throw new Error('No files provided for ingestion.');
  }

  onProgress?.({
    phase: 'parse',
    label: `Parsing ${files.length} local file${files.length === 1 ? '' : 's'} (${files.map((f) => f.name).join(', ')})...`,
    progress_pct: 25,
  });

  onProgress?.({
    phase: 'profile',
    label: 'Profiling schema, counterparties & fiscal calendar...',
    progress_pct: 55,
  });

  let bundle: DatasetBundle | null = null;
  try {
    bundle = ingestFilesDeterministically(files, {
      entityName: entityNameHint,
      isB2B: true,
    });
  } catch {
    bundle = null;
  }

  if (!bundle || bundle.transactions.length === 0) {
    const flexibleRows = parseFlexibleTabularRows(files);
    bundle = buildDatasetBundleFromRows(
      flexibleRows,
      files.map((f) => f.name),
      {},
      {
        entityName: entityNameHint,
        isB2B: true,
      }
    );
  }

  onProgress?.({
    phase: 'verify',
    label: 'Verifying ledger facts & building Finance Story...',
    progress_pct: 88,
  });

  if (bundle.transactions.length === 0) {
    throw new Error(
      'No valid financial transactions could be extracted from the uploaded file(s). Please check that your file contains dates and amounts.'
    );
  }

  onProgress?.({
    phase: 'ready',
    label: `Processed ${bundle.transactions.length.toLocaleString('en-US')} transactions for ${bundle.plan.person_name} — launching report...`,
    progress_pct: 100,
  });

  return bundle;
}

export type { Category };
