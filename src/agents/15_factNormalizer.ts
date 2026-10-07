/**
 * Agent 15: Fact Normalizer
 *
 * Purpose: Turns extracted blocks of a case into normalized facts (currency, amounts, dates, periods) without
 * overwriting raw text. Every fact carries its evidence.
 * Endpoint: POST /agents/fact-normalizer
 * Input Format: { case_id: ID }
 * Output Format: { facts: NormalizedFact[]; warnings?: WarningItem[] }
 */

import { apiClient } from "../api/client";
import type { ID, EvidenceReference, WarningItem } from "../types/canonical";

export const ENDPOINT = "/agents/fact-normalizer";

export interface FactNormalizerInput {
  case_id: ID;
}

export interface NormalizedFact {
  fact_id: ID;
  subject?: string | null;
  metric: string;
  raw_text: string;
  raw_value: string;
  normalized_value: number | string | null;
  currency?: string | null;
  unit?: string | null;
  frequency?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  category?: string | null;
  basis?: string | null;
  normalization_rule: string;
  confidence: number;
  ambiguity_notes?: string[] | null;
  evidence: EvidenceReference[];
}

export interface FactNormalizerOutput {
  facts: NormalizedFact[];
  warnings?: WarningItem[];
}

export async function normalizeFacts(
  input: FactNormalizerInput,
  signal?: AbortSignal
): Promise<FactNormalizerOutput> {
  return apiClient<FactNormalizerOutput>(ENDPOINT, { method: "POST", body: input, signal });
}
