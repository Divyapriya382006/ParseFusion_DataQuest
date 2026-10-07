/**
 * Agent 16: Cross-Document Reasoning
 *
 * Purpose: Compares comparable facts across the documents of a case and reports neutral, evidence-backed
 * potential discrepancies. It never decides anything.
 * Endpoint: POST /agents/cross-doc-reasoning
 * Input Format: { case_id: ID }
 * Output Format: CrossDocReasoningOutput
 */

import { apiClient } from "../api/client";
import type { ID, EvidenceReference, ValidationCheck, WarningItem } from "../types/canonical";

export const ENDPOINT = "/agents/cross-doc-reasoning";

export interface CrossDocReasoningInput {
  case_id: ID;
}

export interface FactComparison {
  comparison_id: ID;
  fact_ids: ID[];
  comparable: boolean;
  checks: ValidationCheck[];
}

export interface NotComparableFactGroup {
  fact_ids: ID[];
  reason: string;
  checks?: ValidationCheck[];
}

export interface DiscrepancyFinding {
  finding_id: ID;
  case_id: ID;
  category: string;
  severity: string;
  status: string;
  title: string;
  statement: string;
  difference_absolute?: number;
  difference_percentage?: number;
  confidence: number;
  human_review_required: boolean;
  possible_explanations?: string[];
  recommended_review_action?: string;
  evidence_references: EvidenceReference[];
}

export interface CrossDocReasoningOutput {
  comparisons: FactComparison[];
  not_comparable: NotComparableFactGroup[];
  findings: DiscrepancyFinding[];
  warnings?: WarningItem[];
}

export async function reasonCrossDoc(
  input: CrossDocReasoningInput,
  signal?: AbortSignal
): Promise<CrossDocReasoningOutput> {
  return apiClient<CrossDocReasoningOutput>(ENDPOINT, { method: "POST", body: input, signal });
}
