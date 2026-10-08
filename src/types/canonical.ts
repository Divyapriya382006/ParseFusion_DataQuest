// Canonical shared types for ParseFusion
// All types represent raw backend schemas without client-side synthetic fields.

export type ID = string;
export type ISODate = string;

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface WarningItem {
  code: string;
  message: string;
  block_id?: ID;
  source_id?: ID;
}

export interface BoundingBox {
  bbox: [number, number, number, number] | null; // [x1, y1, x2, y2]
  coordinate_system: "pixel_top_left";
  page_width: number;
  page_height: number;
  bbox_unavailable_reason?: string;
}

export interface Alternative {
  extractor: string;
  value: string;
  confidence: number;
}

export interface ValidationCheck {
  name: string;
  status: string;
  detail?: string;
}

export interface BaseBlock {
  block_id: ID;
  type: string;
  source_id: ID;
  page_id: ID;
  unit_id?: ID;
  virtual_page_number?: number;
  reading_order_index: number;
  location: BoundingBox;
  confidence: number;
  confidence_breakdown?: Record<string, number>;
  extraction_method: string;
  raw_text?: string;
  raw_value?: string;
  normalized?: {
    value: unknown;
    rule: string;
    currency?: string;
    unit?: string;
  };
  needs_review: boolean;
  warnings: WarningItem[];
  alternatives?: Alternative[];
  validation?: ValidationCheck[];
  locked?: boolean;
  masked?: boolean;
}

export interface TableCell {
  row: number;
  col: number;
  row_span: number;
  col_span: number;
  is_header: boolean;
  raw_text: string;
  normalized?: BaseBlock["normalized"];
  location: BoundingBox;
  confidence: number;
  alternatives?: Alternative[];
  locked?: boolean;
}

export interface TableBadge {
  label: string;
  status: string;
  detail?: string;
}

export interface TableBlock extends BaseBlock {
  type: "table";
  table_id: ID;
  caption?: string;
  n_rows: number;
  n_cols: number;
  cells: TableCell[];
  continues_from?: ID;
  continues_to?: ID;
  badges?: TableBadge[];
}

export interface ChartSeries {
  name: string;
  points: { x: string | number; y: number }[];
}

export interface ChartBlock extends BaseBlock {
  type: "chart";
  chart_id: ID;
  chart_type?: string;
  title?: string;
  crop_url: string;
  axes?: unknown;
  series?: ChartSeries[];
  insight_text?: string;
}

export interface EquationBlock extends BaseBlock {
  type: "equation";
  equation_id: ID;
  latex?: string;
  plain_text?: string;
  crop_url: string;
  verified: boolean;
}

export interface FigureBlock extends BaseBlock {
  type: "figure";
  figure_id: ID;
  crop_url: string;
  caption?: string;
}

export type Block =
  | BaseBlock
  | TableBlock
  | ChartBlock
  | EquationBlock
  | FigureBlock;

export interface PageUnit {
  page_id: ID;
  source_id: ID;
  unit_id: ID;
  page_number: number;
  width: number;
  height: number;
  rotation: number;
  layout_class: string;
  reading_order_confidence: number;
  coverage_score?: number;
  image_url: string;
  uncovered_regions?: BoundingBox[];
  blocks: Block[];
}

export interface SourceDocument {
  source_id: ID;
  filename: string;
  kind: string;
  status: string;
  sha256: string;
  size_bytes: number;
  page_count: number;
  origin: {
    type: "upload" | "url" | "email_attachment";
    url?: string;
    parent_source_id?: ID;
  };
  document_confidence?: number;
  warnings: WarningItem[];
  errors: ApiError[];
  pages?: PageUnit[];
}

export interface EvidenceReference {
  source_id: ID;
  filename: string;
  page_number: number;
  block_id: ID;
  text_excerpt: string;
  bbox: [number, number, number, number] | null;
  confidence: number;
  /** Optional fields. When the backend sends them, hover-to-source uses them instead of looking them up. */
  page_id?: ID;
  extraction_method?: string;
  bbox_unavailable_reason?: string;
  page_width?: number;
  page_height?: number;
  /** Backend-supplied cropped image of the region. When present, no client-side crop is drawn. */
  crop_url?: string;
  /** Restricted values: the popover shows a restricted message only. */
  locked?: boolean;
  masked?: boolean;
}

export interface ProposedAction {
  action_id: ID;
  case_id: ID;
  finding_id?: ID;
  action_type: string;
  status: string;
  risk_level: string;
  requires_human_approval: boolean;
  generated_by: string;
  created_at: ISODate;
  updated_at: ISODate;
  draft_payload: {
    subject?: string;
    recipients?: string[];
    body: string;
    attachments?: { name: string; url: string; mime_type?: string }[];
  };
  supporting_evidence: EvidenceReference[];
  policy_checks: { name: string; status: string; detail?: string }[];
  approved_by?: string;
  approved_at?: ISODate;
  rejected_by?: string;
  rejected_at?: ISODate;
  rejection_reason?: string;
  executed_at?: ISODate;
  execution_result?: Record<string, unknown>;
  idempotency_key: string;
  final_content_hash?: string;
  labels: string[];
}