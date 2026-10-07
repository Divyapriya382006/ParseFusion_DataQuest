/**
 * Agent 05: Layout Detection
 *
 * Purpose: Analyzes page visual zones to classify paragraphs, headings, tables, charts, figures, and headers/footers.
 * Endpoint: POST /agents/layout
 * Input Format: { source_id: ID; page_number: number }
 * Output Format: { layout_class: string; regions: { region_id: ID; type: string; location: BoundingBox; confidence: number }[] }
 */

import { apiClient } from "../api/client";
import type { ID, BoundingBox } from "../types/canonical";

export const ENDPOINT = "/agents/layout";

export interface LayoutDetectionInput {
  source_id: ID;
  page_number: number;
}

export interface LayoutRegion {
  region_id: ID;
  type: string;
  location: BoundingBox;
  confidence: number;
}

export interface LayoutDetectionOutput {
  layout_class: string;
  regions: LayoutRegion[];
}

export async function detectLayout(
  input: LayoutDetectionInput,
  signal?: AbortSignal
): Promise<LayoutDetectionOutput> {
  return apiClient<LayoutDetectionOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
