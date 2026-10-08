import { apiClient } from "./client";
import type { EvidenceReference, ID, WarningItem } from "../types/canonical";

/** Per-source parsing summary (stage "parsing"). */
export interface SourceParseSummary {
  source_id: ID;
  filename: string;
  status: string;
  route?: string | null;
  pages: number;
  blocks: number;
  blocks_by_type: Record<string, number>;
  blocks_by_method: Record<string, number>;
  tables: number;
  figures: number;
  document_confidence: number | null;
  ocr_agreement_mean: number | null;
  needs_review: number;
  reading_order_confidence: number | null;
  warnings: WarningItem[];
  error?: { code: string; message: string } | null;
}

export interface CaseFact {
  fact_id: ID;
  subject: string | null;
  metric: string;
  raw_text: string;
  raw_value: string;
  normalized_value: number | string | null;
  currency?: string | null;
  unit?: string | null;
  frequency?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  basis?: string | null;
  normalization_rule: string;
  confidence: number;
  ambiguity_notes?: string[] | null;
  evidence: EvidenceReference[];
}

export interface CheckResult {
  name: string;
  status: "pass" | "fail";
  detail: string;
}

export interface CaseComparison {
  comparison_id: ID;
  subject: string;
  metric: string;
  fact_ids: ID[];
  source_ids: ID[];
  value_a: number;
  value_b: number;
  currency?: string | null;
  unit?: string | null;
  absolute_difference: number;
  percentage_difference: number;
  tolerance_abs: number;
  tolerance_pct: number;
  within_tolerance: boolean;
  checks: CheckResult[];
  confidence: number | null;
}

export interface CaseNotComparable {
  subject: string;
  metric: string;
  fact_ids: ID[];
  checks: CheckResult[];
  reason: string;
}

export interface CaseFinding {
  finding_id: ID;
  comparison_id: ID;
  title: string;
  statement: string;
  severity: string;
  confidence: number;
  possible_explanations: { explanation: string; suggested_by_check: string }[];
  recommended_review_action: string;
  evidence_references: EvidenceReference[];
}

export interface AnalysisStage {
  stage: "parsing" | "fact_normalization" | "cross_document_reasoning" | string;
  agents: string[];
  status: "completed" | "failed" | string;
  error?: { code: string; message: string };
  output?: unknown;
}

export interface FinalResult {
  verdict: "discrepancies_found" | "consistent" | "insufficient_data" | "failed" | string;
  confidence: number;
  confidence_basis?: string;
  documents?: number;
  facts?: number;
  comparisons?: number;
  not_comparable?: number;
  findings?: number;
  findings_by_severity?: Record<string, number>;
  human_review_required?: boolean;
  summary?: string;
  duration_ms?: number;
  error?: { code: string; message: string };
}

export interface CaseAnalysis {
  case_id: ID;
  analyzed_at?: string;
  stages: AnalysisStage[];
  final: FinalResult;
}

export function analyzeCase(caseId: ID): Promise<CaseAnalysis> {
  return apiClient<CaseAnalysis>(`/cases/${caseId}/analyze`, { method: "POST" });
}

export function getCaseAnalysis(caseId: ID, signal?: AbortSignal): Promise<CaseAnalysis> {
  return apiClient<CaseAnalysis>(`/cases/${caseId}/analysis`, { signal });
}

export function attachSourcesToCase(caseId: ID, sourceIds: ID[]): Promise<unknown> {
  return apiClient(`/cases/${caseId}/sources`, { method: "POST", body: { source_ids: sourceIds } });
}
