/**
 * Shared local browser ingestion contracts.
 * Single source of truth connecting the B2B pipeline and client-side ingestion UI.
 */

import type { Fact } from './data.js';

export interface RawIngestFile {
  name: string;
  mimeType: string;
  /** UTF-8 text for CSV/TSV/JSON/TXT, or base64 payload for XLSX */
  content: string;
  encoding?: 'utf8' | 'base64';
}

export interface IngestProgressStep {
  phase: 'parse' | 'profile' | 'verify' | 'ready';
  label: string;
  detail?: string;
  progress_pct: number;
}

export type FactMapLike = ReadonlyMap<string, Fact>;
