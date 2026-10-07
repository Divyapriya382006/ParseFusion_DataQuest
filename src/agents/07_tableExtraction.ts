/**
 * Agent 07: Table Extraction
 *
 * Purpose: Reconstructs complex grid tabular structures, cell row/column spans, headers, and numeric values.
 * Endpoint: POST /agents/table
 * Input Format: { source_id: ID; page_number: number; region_id: ID }
 * Output Format: TableBlock
 */

import { apiClient } from "../api/client";
import type { ID, TableBlock } from "../types/canonical";

export const ENDPOINT = "/agents/table";

export interface TableExtractionInput {
  source_id: ID;
  page_number: number;
  region_id: ID;
}

export type TableExtractionOutput = TableBlock;

export async function extractTable(
  input: TableExtractionInput,
  signal?: AbortSignal
): Promise<TableExtractionOutput> {
  return apiClient<TableExtractionOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
