import { apiClient } from "./client";
import type { BatchSummary, BatchSummaryRow } from "../types/api";
import type { ID } from "../types/canonical";

export interface CreateBatchInput {
  source_ids: ID[];
  mode: string;
  output_formats: string[];
  case_id?: ID;
  instructions?: string;
  options?: Record<string, boolean | string | number>;
}

export interface CreateBatchOutput {
  batch_id: ID;
  job_id: ID;
  status: string;
}

export async function createBatch(input: CreateBatchInput): Promise<CreateBatchOutput> {
  return apiClient<CreateBatchOutput>("/batches", {
    method: "POST",
    body: input,
  });
}

export async function getBatch(batchId: ID, signal?: AbortSignal): Promise<BatchSummary> {
  return apiClient<BatchSummary>(`/batches/${batchId}`, { signal });
}

export async function listBatches(signal?: AbortSignal): Promise<{ batches: BatchSummary[] }> {
  return apiClient<{ batches: BatchSummary[] }>("/batches", { signal });
}

export async function retryBatchSource(batchId: ID, sourceId: ID): Promise<{ job_id: ID }> {
  return apiClient<{ job_id: ID }>(`/batches/${batchId}/retry`, {
    method: "POST",
    body: { source_id: sourceId },
  });
}

/** (Re)run fact normalization + cross-document reasoning over a finished batch. */
export async function analyzeBatch(batchId: ID): Promise<BatchSummary> {
  return apiClient<BatchSummary>(`/batches/${batchId}/analyze`, { method: "POST" });
}

export async function listBatchSummaries(
  params: { q?: string; offset?: number; limit?: number; includeArchived?: boolean },
  signal?: AbortSignal
): Promise<{ total: number; offset: number; limit: number; batches: BatchSummaryRow[] }> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.offset) qs.set("offset", String(params.offset));
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.includeArchived) qs.set("include_archived", "true");
  return apiClient(`/batches/summary?${qs.toString()}`, { signal });
}

export async function archiveBatch(batchId: ID, archived: boolean): Promise<unknown> {
  return apiClient(`/batches/${batchId}/archive`, { method: "POST", body: { archived } });
}

export async function deleteBatch(batchId: ID): Promise<unknown> {
  return apiClient(`/batches/${batchId}`, { method: "DELETE" });
}
