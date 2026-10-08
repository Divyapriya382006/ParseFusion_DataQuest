import { apiClient } from "./client";
import type { BatchSummary } from "../types/api";
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
