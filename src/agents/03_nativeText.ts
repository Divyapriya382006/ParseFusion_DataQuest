/**
 * Agent 03: Native Text Extractor
 *
 * Purpose: Extracts digitally embedded vector font glyphs and text spans directly from electronic documents.
 * Endpoint: POST /agents/native-text
 * Input Format: { source_id: ID; page_number: number }
 * Output Format: { page_id: ID; spans: { text: string; location: BoundingBox; font?: string; confidence: number }[]; has_usable_text: boolean }
 */

import { apiClient } from "../api/client";
import type { ID, BoundingBox } from "../types/canonical";

export const ENDPOINT = "/agents/native-text";

export interface NativeTextInput {
  source_id: ID;
  page_number: number;
}

export interface NativeTextOutput {
  page_id: ID;
  spans: {
    text: string;
    location: BoundingBox;
    font?: string;
    confidence: number;
  }[];
  has_usable_text: boolean;
}

export async function extractNativeText(
  input: NativeTextInput,
  signal?: AbortSignal
): Promise<NativeTextOutput> {
  return apiClient<NativeTextOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
