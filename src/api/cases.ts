import { apiClient } from "./client";
import type { CaseRecord } from "../types/api";
import type { ID } from "../types/canonical";

export interface CreateCaseInput {
  title: string;
  metadata?: Record<string, unknown>;
}

export async function listCases(signal?: AbortSignal): Promise<{ cases: CaseRecord[] }> {
  return apiClient<{ cases: CaseRecord[] }>("/cases", { signal });
}

export async function createCase(input: CreateCaseInput): Promise<CaseRecord> {
  return apiClient<CaseRecord>("/cases", {
    method: "POST",
    body: input,
  });
}

export async function getCase(caseId: ID, signal?: AbortSignal): Promise<CaseRecord> {
  return apiClient<CaseRecord>(`/cases/${caseId}`, { signal });
}
