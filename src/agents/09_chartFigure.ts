/**
 * Agent 09: Chart & Figure Agent
 *
 * Purpose: Analyzes graphical charts, vector plots, visual figures, extracts underlying series data and generates crop previews.
 * Endpoint: POST /agents/chart-figure
 * Input Format: { source_id: ID; page_number: number; region_id: ID }
 * Output Format: ChartBlock | FigureBlock
 */

import { apiClient } from "../api/client";
import type { ID, ChartBlock, FigureBlock } from "../types/canonical";

export const ENDPOINT = "/agents/chart-figure";

export interface ChartFigureInput {
  source_id: ID;
  page_number: number;
  region_id: ID;
}

export type ChartFigureOutput = ChartBlock | FigureBlock;

export async function extractChartFigure(
  input: ChartFigureInput,
  signal?: AbortSignal
): Promise<ChartFigureOutput> {
  return apiClient<ChartFigureOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
