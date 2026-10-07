/**
 * Agent 12: Confidence & Validation
 *
 * Purpose: Evaluates block confidence distributions, checksums, and verification rules; assigns review flags and badges.
 * Endpoint: POST /agents/confidence-validation
 * Input Format: { source_id: ID }
 * Output Format: { document_confidence: number; blocks: { block_id: ID; confidence: number; confidence_breakdown: Record<string, number>; checks: ValidationCheck[]; needs_review: boolean }[]; badges: { scope_id: ID; label: string; status: string; detail?: string }[] }
 */

import { apiClient } from "../api/client";
import type { ID, ValidationCheck } from "../types/canonical";

export const ENDPOINT = "/agents/confidence-validation";

export interface ConfidenceValidationInput {
  source_id: ID;
}

export interface BlockValidationResult {
  block_id: ID;
  confidence: number;
  confidence_breakdown: Record<string, number>;
  checks: ValidationCheck[];
  needs_review: boolean;
}

export interface ValidationBadge {
  scope_id: ID;
  label: string;
  status: string;
  detail?: string;
}

export interface ConfidenceValidationOutput {
  document_confidence: number;
  blocks: BlockValidationResult[];
  badges: ValidationBadge[];
}

export async function validateConfidence(
  input: ConfidenceValidationInput,
  signal?: AbortSignal
): Promise<ConfidenceValidationOutput> {
  return apiClient<ConfidenceValidationOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
