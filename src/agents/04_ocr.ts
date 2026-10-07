/**
 * Agent 04: OCR Engine
 *
 * Purpose: Performs optical character recognition on scanned pages or designated image sub-regions.
 * Endpoint: POST /agents/ocr
 * Input Format: { source_id: ID; page_number: number; region?: BoundingBox; engine?: string }
 * Output Format: { engine: string; lines: { text: string; location: BoundingBox; confidence: number }[]; handwriting_detected?: boolean }
 */

import { apiClient } from "../api/client";
import type { ID, BoundingBox } from "../types/canonical";

export const ENDPOINT = "/agents/ocr";

export interface OcrInput {
  source_id: ID;
  page_number: number;
  region?: BoundingBox;
  engine?: string;
}

export interface OcrOutput {
  engine: string;
  lines: {
    text: string;
    location: BoundingBox;
    confidence: number;
  }[];
  handwriting_detected?: boolean;
}

export async function runOcr(
  input: OcrInput,
  signal?: AbortSignal
): Promise<OcrOutput> {
  return apiClient<OcrOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
