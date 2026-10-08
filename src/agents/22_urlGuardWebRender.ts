/**
 * Agent 22: URL Guard & Web Ingestion
 *
 * Purpose: Inspects submitted website URLs against robots.txt and corporate governance policies, renders DOM,
 * captures evidence snapshots, and routes rendered artifacts to document pipeline.
 * Endpoint: POST /agents/url-ingest
 * Input Format: { url: string; purpose?: string; authorization_basis?: string }
 * Output Format: { status: "allowed" | "blocked"; reason?: string; robots_checked: boolean; source_id?: ID; snapshot?: { screenshot_url: string; fetched_at: ISODate }; error?: ApiError }
 */

import { apiClient } from "../api/client";
import type { ID, ISODate, ApiError } from "../types/canonical";

export const ENDPOINT = "/agents/url-ingest";

export interface UrlIngestInput {
  url: string;
  purpose?: string;
  authorization_basis?: string;
}

export interface UrlIngestOutput {
  status: "allowed" | "blocked" | "failed";
  reason?: string;
  robots_checked: boolean;
  source_id?: ID;
  links?: Array<{ text: string; url: string }>;
  snapshot?: {
    screenshot_url: string;
    fetched_at: ISODate;
  };
  error?: ApiError;
}

export async function ingestUrl(
  input: UrlIngestInput,
  signal?: AbortSignal
): Promise<UrlIngestOutput> {
  return apiClient<UrlIngestOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
