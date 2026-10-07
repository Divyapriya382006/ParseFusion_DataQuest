/**
 * Agent 06: Reading Order
 *
 * Purpose: Determines linear topological human reading order across multi-column, callout, and complex layouts.
 * Endpoint: POST /agents/reading-order
 * Input Format: { page_id: ID; region_ids: ID[] }
 * Output Format: { ordered_ids: ID[]; reading_order_confidence: number; warnings: WarningItem[] }
 */

import { apiClient } from "../api/client";
import type { ID, WarningItem } from "../types/canonical";

export const ENDPOINT = "/agents/reading-order";

export interface ReadingOrderInput {
  page_id: ID;
  region_ids: ID[];
}

export interface ReadingOrderOutput {
  ordered_ids: ID[];
  reading_order_confidence: number;
  warnings: WarningItem[];
}

export async function determineReadingOrder(
  input: ReadingOrderInput,
  signal?: AbortSignal
): Promise<ReadingOrderOutput> {
  return apiClient<ReadingOrderOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
