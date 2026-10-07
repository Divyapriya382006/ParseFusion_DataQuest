/**
 * Agent 20: Multi-Format Export Agent
 *
 * Purpose: Packages normalized facts, source documents, evidence trails, and audit records into verifiable export archives.
 * Endpoint: POST /agents/export and GET /agents/export/history
 * Input Format: { scope: { type: string; ids: ID[] }; format: string; options?: { masked?: boolean; include_evidence?: boolean } }
 * Output Format: ExportRecord and { exports: ExportRecord[] }
 */

import { apiClient } from "../api/client";
import type { ID, ISODate } from "../types/canonical";

export const ENDPOINT = "/agents/export";
export const HISTORY_ENDPOINT = "/agents/export/history";

export interface ExportInput {
  scope: {
    type: string;
    ids: ID[];
  };
  format: string;
  options?: {
    masked?: boolean;
    include_evidence?: boolean;
  };
}

export interface ExportRecord {
  export_id: ID;
  format: string;
  download_url: string;
  content_hash: string;
  signed_manifest_url?: string;
  created_at: ISODate;
}

export interface ExportHistoryOutput {
  exports: ExportRecord[];
}

export async function requestExport(
  input: ExportInput,
  signal?: AbortSignal
): Promise<ExportRecord> {
  return apiClient<ExportRecord>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}

export async function fetchExportHistory(
  signal?: AbortSignal
): Promise<ExportHistoryOutput> {
  return apiClient<ExportHistoryOutput>(HISTORY_ENDPOINT, {
    method: "GET",
    signal,
  });
}
