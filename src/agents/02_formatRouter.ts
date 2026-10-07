/**
 * Agent 02: Format Router
 *
 * Purpose: Determines routing path based on document layout and page classes. Splits documents into processing units.
 * Endpoint: POST /agents/format-router
 * Input Format: { source_id: ID }
 * Output Format: { source_id: ID, route: string, units: { unit_id: ID, page_number: number, page_class: string }[] }
 */

import { apiClient } from "../api/client";
import type { ID } from "../types/canonical";

export const ENDPOINT = "/agents/format-router";

export interface FormatRouterInput {
  source_id: ID;
}

export interface FormatRouterOutput {
  source_id: ID;
  route: string;
  units: {
    unit_id: ID;
    page_number: number;
    page_class: string;
  }[];
}

export async function routeFormat(
  input: FormatRouterInput,
  signal?: AbortSignal
): Promise<FormatRouterOutput> {
  return apiClient<FormatRouterOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
