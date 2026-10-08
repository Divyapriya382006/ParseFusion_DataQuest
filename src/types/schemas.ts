import { z } from "zod";

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const WarningItemSchema = z.object({
  code: z.string(),
  message: z.string(),
  block_id: z.string().optional(),
  source_id: z.string().optional(),
});

export const BoundingBoxSchema = z.object({
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  coordinate_system: z.literal("pixel_top_left"),
  page_width: z.number(),
  page_height: z.number(),
  bbox_unavailable_reason: z.string().optional(),
});

export const AlternativeSchema = z.object({
  extractor: z.string(),
  value: z.string(),
  confidence: z.number(),
});

export const ValidationCheckSchema = z.object({
  name: z.string(),
  status: z.string(),
  detail: z.string().optional(),
});

export const BaseBlockSchema = z.object({
  block_id: z.string(),
  type: z.string(),
  source_id: z.string(),
  page_id: z.string(),
  unit_id: z.string().optional(),
  virtual_page_number: z.number().optional(),
  reading_order_index: z.number(),
  location: BoundingBoxSchema,
  confidence: z.number(),
  confidence_breakdown: z.record(z.string(), z.number()).optional(),
  extraction_method: z.string(),
  raw_text: z.string().optional(),
  raw_value: z.string().optional(),
  normalized: z
    .object({
      value: z.unknown(),
      rule: z.string(),
      currency: z.string().optional(),
      unit: z.string().optional(),
    })
    .optional(),
  needs_review: z.boolean(),
  warnings: z.array(WarningItemSchema),
  alternatives: z.array(AlternativeSchema).optional(),
  validation: z.array(ValidationCheckSchema).optional(),
  locked: z.boolean().optional(),
  masked: z.boolean().optional(),
});

export const TableCellSchema = z.object({
  row: z.number(),
  col: z.number(),
  row_span: z.number(),
  col_span: z.number(),
  is_header: z.boolean(),
  raw_text: z.string(),
  normalized: BaseBlockSchema.shape.normalized,
  location: BoundingBoxSchema,
  confidence: z.number(),
  alternatives: z.array(AlternativeSchema).optional(),
  locked: z.boolean().optional(),
});

export const TableBlockSchema = BaseBlockSchema.extend({
  type: z.literal("table"),
  table_id: z.string(),
  caption: z.string().optional(),
  n_rows: z.number(),
  n_cols: z.number(),
  cells: z.array(TableCellSchema),
  continues_from: z.string().optional(),
  continues_to: z.string().optional(),
  badges: z
    .array(
      z.object({
        label: z.string(),
        status: z.string(),
        detail: z.string().optional(),
      })
    )
    .optional(),
});

export const ChartBlockSchema = BaseBlockSchema.extend({
  type: z.literal("chart"),
  chart_id: z.string(),
  chart_type: z.string().optional(),
  title: z.string().optional(),
  crop_url: z.string(),
  axes: z.unknown().optional(),
  series: z
    .array(
      z.object({
        name: z.string(),
        points: z.array(
          z.object({
            x: z.union([z.string(), z.number()]),
            y: z.number(),
          })
        ),
      })
    )
    .optional(),
  insight_text: z.string().optional(),
});

export const EquationBlockSchema = BaseBlockSchema.extend({
  type: z.literal("equation"),
  equation_id: z.string(),
  latex: z.string().optional(),
  plain_text: z.string().optional(),
  crop_url: z.string(),
  verified: z.boolean(),
});

export const FigureBlockSchema = BaseBlockSchema.extend({
  type: z.literal("figure"),
  figure_id: z.string(),
  crop_url: z.string(),
  caption: z.string().optional(),
});

export const BlockSchema = z.union([
  TableBlockSchema,
  ChartBlockSchema,
  EquationBlockSchema,
  FigureBlockSchema,
  BaseBlockSchema,
]);

export const EvidenceReferenceSchema = z.object({
  source_id: z.string(),
  filename: z.string(),
  page_number: z.number(),
  block_id: z.string(),
  text_excerpt: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  confidence: z.number(),
  page_id: z.string().optional(),
  extraction_method: z.string().optional(),
  bbox_unavailable_reason: z.string().optional(),
  page_width: z.number().optional(),
  page_height: z.number().optional(),
  crop_url: z.string().optional(),
  locked: z.boolean().optional(),
  masked: z.boolean().optional(),
});

export const AppConfigSchema = z.object({
  poll_interval_ms: z.number().default(2000),
  realtime_url: z.string().optional(),
  auth: z.object({
    mode: z.string(),
    login_url: z.string().optional(),
  }),
  processing_modes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string().optional(),
    })
  ),
  output_formats: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
    })
  ),
  export_scopes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
    })
  ),
  action_types: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
    })
  ),
  limits: z.object({
    max_file_mb: z.number(),
    max_pages: z.number(),
    accepted_types: z.array(z.string()),
  }),
  confidence_bands: z.array(
    z.object({
      id: z.string(),
      min: z.number(),
      max: z.number(),
      label: z.string(),
    })
  ),
  severity_levels: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
    })
  ),
  feature_flags: z.record(z.string(), z.boolean()),
  pipeline_stages: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
    })
  ),
});

export const UserProfileSchema = z.object({
  user_id: z.string(),
  display_name: z.string(),
  role: z.string(),
  capabilities: z.array(z.string()),
  tenant_id: z.string().optional(),
});