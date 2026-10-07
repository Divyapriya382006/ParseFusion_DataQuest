// API envelope and cross-cutting types
import type { ID, ISODate, ApiError } from "./canonical";

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
  pipeline_stages: PipelineStage[];
}

export interface UserProfile {
  user_id: string;
  display_name: string;
  role: string;
  capabilities: string[];
  tenant_id?: string;
}

export interface BatchSummary {
  batch_id: ID;
  created_at: ISODate;
  status: string;
  source_ids: ID[];
  case_id?: ID;
  progress_percent?: number;
  stage?: string;
  sources_summary?: {
    total: number;
    completed: number;
    failed: number;
  };
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
