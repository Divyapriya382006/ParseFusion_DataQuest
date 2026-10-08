// API envelope and cross-cutting types
import type { ID, ISODate, ApiError, WarningItem } from "./canonical";

export interface ApiResponseSuccess<T> {
  ok: true;
  data: T;
  request_id: string;
}

export interface ApiResponseFailure {
  ok: false;
  error: ApiError;
  request_id: string;
}

export type ApiResponse<T> = ApiResponseSuccess<T> | ApiResponseFailure;

export interface JobStatus<TResult = unknown> {
  job_id: ID;
  status: "queued" | "running" | "completed" | "failed" | string;
  stage?: string;
  progress_percent?: number;
  result?: TResult;
  error?: ApiError;
}

export interface ProcessingMode {
  id: string;
  label: string;
  description?: string;
}

export interface OutputFormatOption {
  id: string;
  label: string;
}

export interface ExportScopeOption {
  id: string;
  label: string;
}

export interface ActionTypeOption {
  id: string;
  label: string;
}

export interface ConfidenceBand {
  id: string;
  min: number;
  max: number;
  label: string;
}

export interface SeverityLevel {
  id: string;
  label: string;
}

export interface PipelineStage {
  id: string;
  label: string;
}

export interface AppConfig {
  poll_interval_ms: number;
  realtime_url?: string;
  auth: {
    mode: "bearer" | "cookie" | "none" | string;
    login_url?: string;
  };
  processing_modes: ProcessingMode[];
  output_formats: OutputFormatOption[];
  export_scopes: ExportScopeOption[];
  action_types: ActionTypeOption[];
  limits: {
    max_file_mb: number;
    max_pages: number;
    accepted_types: string[];
  };
  confidence_bands: ConfidenceBand[];
  severity_levels: SeverityLevel[];
  feature_flags: Record<string, boolean>;
  ui?: { batch_page_size?: number; block_render_chunk?: number; shred_max_chars?: number; shred_min_run?: number };
  pipeline_stages: PipelineStage[];
}

export interface UserProfile {
  user_id: string;
  display_name: string;
  role: string;
  capabilities: string[];
  demo_role_switch_enabled?: boolean;
  tenant_id?: string;
}

export interface BatchSummary {
  batch_id: ID;
  job_id?: ID;
  created_at: ISODate;
  status: string;
  source_ids: ID[];
  output_formats?: string[];
  exports?: {
    export_id: ID;
    format: string;
    download_url: string;
    content_hash: string;
  }[];
  export_errors?: {
    format: string;
    code: string;
    message: string;
  }[];
  case_id?: ID;
  progress_percent?: number;
  stage?: string;
  sources_summary?: {
    total: number;
    completed: number;
    failed: number;
  };
  /** Per-document state, with what parsing produced once pages exist. */
  sources?: BatchSourceState[];
  /** Cross-document reasoning over the batch's documents, run automatically once parsing finishes. */
  analysis?: BatchAnalysisState;
  notices?: { code: string; message: string; source_id?: ID; batch_id?: ID }[];
  archived?: boolean;
}

export interface BatchSummaryRow {
  batch_id: ID;
  created_at: ISODate;
  status: string;
  stage?: string;
  progress_percent?: number;
  documents: { source_id: ID; filename: string; status: string; unread_pages: number }[];
  document_count: number;
  score: number | null;
  warnings_count: number;
  export_status: string;
  export_errors: { format: string; code: string; message: string; reason?: string }[];
  analysis_status: string;
  unread_pages: number;
  archived: boolean;
}

export interface BatchAnalysisState {
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "not_run" | string;
  case_id?: ID | null;
  analyzed_at?: ISODate;
  reason?: string;
  error?: { code: string; message: string };
  final?: { verdict: string; confidence: number | null; summary?: string };
}

export interface BatchSourceParse {
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
  route?: string | null;
  /** Document parse score, capped when a check could not run (cap.reason says why). */
  parse_score?: { value: number | null; cap: { applied: boolean; reason?: string; max?: number }; formula?: string };
  warnings: WarningItem[];
}

export interface BatchSourceState {
  source_id: ID;
  filename?: string;
  status: string;
  stage?: string;
  error?: { code: string; message: string } | null;
  parse?: BatchSourceParse;
}

export interface MetricItem {
  id: string;
  label: string;
  value: number;
  unit?: string;
  series?: { t: ISODate; v: number }[];
}

export interface MetricsResponse {
  items: MetricItem[];
}

export interface AgentHealth {
  id: string;
  name: string;
  status: "healthy" | "degraded" | "offline" | string;
  latency_ms?: number;
}

export interface HealthResponse {
  agents: AgentHealth[];
}

export interface CaseRecord {
  case_id: ID;
  title: string;
  status: string;
  created_at: ISODate;
  updated_at: ISODate;
  source_ids: ID[];
  metadata?: Record<string, unknown>;
}
