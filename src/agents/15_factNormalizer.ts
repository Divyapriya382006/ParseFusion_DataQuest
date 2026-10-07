/**
 * Agent 15: Fact Normalizer
 *
 * Purpose: Extracts canonical facts from documents in a case, harmonizing currencies, dates, frequencies, and metrics with evidence anchors.
 * Endpoint: POST /agents/fact-normalizer
 * Input Format: { case_id: ID }
 * Output Format: { facts: NormalizedFact[] }
 */

import { apiClient } from "../api/client";
import type { ID, ISODate, EvidenceReference } from "../types/canonical";

export const ENDPOINT = "/agents/fact-normalizer";

export interface FactNormalizerInput {
  case_id: ID;
}

export interface NormalizedFact {
  fact_id: ID;
  subject: string;
  metric: string;
  raw_text: string;
  raw_value: string;
  normalized_value: number | string | null;
  currency?: string;
  unit?: string;
  frequency?: string;
  period_start?: ISODate;
  period_end?: ISODate;
  category?: string;
  basis?: string;
  normalization_rule: string;
  confidence: number;
  ambiguity_notes?: string[];
  evidence: EvidenceReference[];
}

export interface FactNormalizerOutput {
  facts: NormalizedFact[];
}

export async function normalizeFacts(
  input: FactNormalizerInput,
  signal?: AbortSignal
): Promise<FactNormalizerOutput> {
  return apiClient<FactNormalizerOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
