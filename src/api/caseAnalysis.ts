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
  /** Where the value came from (table cell keeps its row label and column headers). */
  origin?: FactOrigin | null;
}

export interface FactOrigin {
  type: "table_cell" | "key_value" | "text" | "sentence" | string;
  table_id?: string;
  row_label?: string;
  column_headers?: string[];
  row?: number;
  col?: number;
}

export interface ParseScore {
  value: number | null;
  components: Record<string, number>;
  cap: { applied: boolean; max?: number; reason?: string; code?: string; config_key?: string };
  formula?: string;
}

export interface SkippedCandidate {
  source_id: ID;
  ref_id: string;
  reason_code: string;
  failing_field?: string | null;
  raw_text: string;
}

export interface ReportDocument {
  source_id: ID;
  filename: string;
  doc_type_guess?: { label: string; confidence: number; matched: string[]; method: string } | null;
  parse: {
    pages: number;
    blocks: number;
    tables: number;
    figures: number;
    route?: string | null;
    blocks_by_method: Record<string, number>;
    needs_review: number;
    unverified_blocks?: number;
    warning_counts: { code: string; message: string; count: number }[];
    error?: { code: string; message: string } | null;
  };
  parse_score: ParseScore | null;
  facts: {
    candidates: number | null;
    accepted: number;
    skipped_total: number | null;
    skipped: { reason_code: string; count: number }[];
    unclassified_numbers: number | null;
    zero_fact_reason?: string | null;
  };
}

export interface RelatednessCell {
  source_a: ID;
  source_b: ID;
  filename_a?: string;
  filename_b?: string;
  score: number | null;
  reason?: string;
  signals: { name: string; matched: boolean; detail: string }[];
  topic_similarity?: { value: number | null; method: string; shared_terms: string[] };
  shared_entities?: string[];
  shared_attributes?: string[];
  shared_attributes_count?: number;
  shared_periods?: string[];
  relation_summary?: string;
}

export interface FunnelStage {
  stage: string;
  unit: "facts" | "groups" | "pairs" | string;
  count: number;
  dropped?: number;
  reason_code?: string | null;
  example_ids?: unknown[];
  note?: string;
}

export interface AttributeOverlap {
  attribute_normalized: string;
  entities: string[];
  documents: { source_id: ID; filename: string; fact_ids: ID[] }[];
  shared_across_documents: boolean;
  unverified_fact_ids?: ID[];
}

export interface ScoreComponent {
  name: string;
  value: number | null;
  weight?: number | null;
  weight_config_key?: string | null;
  detail?: string;
  detail_config_key?: string | null;
}

export interface CaseScore {
  status: "scored" | "not_scored" | string;
  value: number | null;
  reason?: string;
  reason_code?: string;
  reason_text?: string;
  /** List in current backends; older analyses returned {name: value}. */
  components: ScoreComponent[] | Record<string, number | null>;
  formula_description: string;
}

export interface ReasoningReport {
  documents: ReportDocument[];
  skipped_candidates: SkippedCandidate[];
  relatedness: RelatednessCell[];
  not_comparable_summary: { reason_code: string; count: number; example?: string; example_fact_ids: ID[][] }[];
  dropped_by_reasoning: { code: string; count: number }[];
  no_pairs_reason?: string | null;
  unlock: string[];
  unlock_hints?: { reason_code: string; text: string }[];
  funnel?: FunnelStage[];
  attribute_overlap?: AttributeOverlap[];
  case_score: CaseScore;
  counts: Record<string, number>;
  reconciliation: { check: string; ok: boolean; detail: string }[];
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
  verdict: "discrepancies_found" | "consistent" | "not_scored" | "insufficient_data" | "failed" | string;
  /** null when nothing could be scored (never shown as 0%). */
  confidence: number | null;
  score_status?: string;
  not_scored_reason?: string | null;
  facts_skipped?: number;
  pairs_considered?: number;
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
  /** Present for analyses made by the current backend. */
  report?: ReasoningReport;
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
