/**
 * Agent 08: Spreadsheet Extractor
 *
 * Purpose: Parses workbook sheets, formulas, cell coordinate values, merged ranges, and hidden structures.
 * Endpoint: POST /agents/spreadsheet
 * Input Format: { source_id: ID }
 * Output Format: { sheets: { name: string; hidden: boolean; used_range: string; merged_ranges: string[]; probable_tables: string[]; cells: { ref: string; raw_value: unknown; displayed_value: string; formula?: string; number_format?: string; hidden?: boolean }[] }[] }
 */

import { apiClient } from "../api/client";
import type { ID } from "../types/canonical";

export const ENDPOINT = "/agents/spreadsheet";

export interface SpreadsheetInput {
  source_id: ID;
}

export interface SpreadsheetCell {
  ref: string;
  raw_value: unknown;
  displayed_value: string;
  formula?: string;
  number_format?: string;
  hidden?: boolean;
}

export interface SpreadsheetSheet {
  name: string;
  hidden: boolean;
  used_range: string;
  merged_ranges: string[];
  probable_tables: string[];
  cells: SpreadsheetCell[];
}

export interface SpreadsheetOutput {
  sheets: SpreadsheetSheet[];
}

export async function parseSpreadsheet(
  input: SpreadsheetInput,
  signal?: AbortSignal
): Promise<SpreadsheetOutput> {
  return apiClient<SpreadsheetOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
