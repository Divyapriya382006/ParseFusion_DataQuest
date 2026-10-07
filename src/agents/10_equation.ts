/**
 * Agent 10: Equation Extractor
 *
 * Purpose: Recognizes mathematical formulas, converts glyphs to LaTeX syntax, plain text, and performs symbolic verification.
 * Endpoint: POST /agents/equation
 * Input Format: { source_id: ID; page_number: number; region_id: ID }
 * Output Format: EquationBlock
 */

import { apiClient } from "../api/client";
import type { ID, EquationBlock } from "../types/canonical";

export const ENDPOINT = "/agents/equation";

export interface EquationInput {
  source_id: ID;
  page_number: number;
  region_id: ID;
}

export type EquationOutput = EquationBlock;

export async function extractEquation(
  input: EquationInput,
  signal?: AbortSignal
): Promise<EquationOutput> {
  return apiClient<EquationOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
