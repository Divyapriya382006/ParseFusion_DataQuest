/**
 * Agent 11: JSON Assembly
 *
 * Purpose: Aggregates disparate extracted blocks, reading orders, and page structures into a unified canonical SourceDocument.
 * Endpoint: POST /agents/json-assembly
 * Input Format: { source_id: ID }
 * Output Format: SourceDocument
 */

import { apiClient } from "../api/client";
import type { ID, SourceDocument } from "../types/canonical";

export const ENDPOINT = "/agents/json-assembly";

export interface JsonAssemblyInput {
  source_id: ID;
}

export type JsonAssemblyOutput = SourceDocument;

export async function assembleJson(
  input: JsonAssemblyInput,
  signal?: AbortSignal
): Promise<JsonAssemblyOutput> {
  return apiClient<JsonAssemblyOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
