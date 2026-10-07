/**
 * Agent 13: Virtual Document Merge
 *
 * Purpose: Pure page mapping that numbers the pages of several sources 1..N without touching any source.
 * Endpoint: POST /agents/virtual-merge
 * Input Format: { batch_id: ID; ordered_source_ids: ID[] }
 * Output Format: VirtualMergeOutput
 */

import { apiClient } from "../api/client";
import type { ID } from "../types/canonical";

export const ENDPOINT = "/agents/virtual-merge";

export interface VirtualMergeInput {
  batch_id: ID;
  ordered_source_ids: ID[];
}

export interface VirtualPageMapping {
  virtual_page_number: number;
  source_id: ID;
  page_number: number;
  page_id: ID;
  boundary_start: boolean;
}

export interface VirtualMergeOutput {
  virtual_document_id: ID;
  pages: VirtualPageMapping[];
}

export async function mergeVirtualDocument(
  input: VirtualMergeInput,
  signal?: AbortSignal
): Promise<VirtualMergeOutput> {
  return apiClient<VirtualMergeOutput>(ENDPOINT, { method: "POST", body: input, signal });
}
