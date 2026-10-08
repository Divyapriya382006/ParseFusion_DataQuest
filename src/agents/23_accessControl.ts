/**
 * Agent 23: Governed Access Control & Column-Level Security
 *
 * Purpose: Enforces table and column-level masking, presents locked metadata schemas, processes human access elevation requests,
 * and manages access policy approvals.
 * Endpoints:
 *   - GET /agents/access/schema
 *   - GET /agents/access/preview
 *   - POST /agents/access/request
 *   - GET /agents/access/requests
 *   - POST /agents/access/decision
 */

import { apiClient } from "../api/client";
import type { ID, ISODate } from "../types/canonical";

export const ENDPOINT_SCHEMA = "/agents/access/schema";
export const ENDPOINT_PREVIEW = "/agents/access/preview";
export const ENDPOINT_REQUEST = "/agents/access/request";
export const ENDPOINT_REQUESTS = "/agents/access/requests";
export const ENDPOINT_DECISION = "/agents/access/decision";
export const ENDPOINT_DOCUMENTS = "/agents/access/documents";
export const ENDPOINT_DOCUMENT_REQUEST = "/agents/access/document-request";
export const ENDPOINT_DOCUMENT_REQUESTS = "/agents/access/document-requests";
export const ENDPOINT_DOCUMENT_DECISION = "/agents/access/document-decision";
export const ENDPOINT_DOCUMENT_VISIBILITY = "/agents/access/document-visibility";

// Standard ENDPOINT constant pointing to primary resource schema
export const ENDPOINT = ENDPOINT_SCHEMA;

export interface AccessTableColumn {
  name: string;
  type?: string;
  locked: boolean;
}

export interface AccessTable {
  resource_id: ID;
  schema: string;
  name: string;
  locked: boolean;
  columns: AccessTableColumn[];
}

export interface AccessSchemaOutput {
  tables: AccessTable[];
}

export interface AccessPreviewInput {
  resource_id: ID;
  limit?: number;
}

export interface AccessPreviewColumn {
  name: string;
  locked: boolean;
}

export interface AccessPreviewOutput {
  columns: AccessPreviewColumn[];
  rows: (unknown | null)[][];
}

export interface AccessRequestInput {
  resource_id: ID;
  columns?: string[];
  reason: string;
  requested_duration?: string;
}

export interface AccessRequestOutput {
  request_id: ID;
  status: string;
}

export interface AccessRequestItem {
  request_id: ID;
  user_id: string;
  resource_id: ID;
  columns?: string[];
  reason: string;
  status: string;
  requested_at: ISODate;
  valid_until?: ISODate;
}

export interface AccessRequestsListOutput {
  requests: AccessRequestItem[];
}

export interface AccessDecisionInput {
  request_id: ID;
  decision: "approve" | "reject";
  valid_until?: ISODate;
  notes?: string;
}

export interface AccessDecisionOutput {
  request_id: ID;
  status: string;
  signature?: string;
}

export interface DocumentAccessItem {
  source_id: ID;
  filename: string;
  kind: string;
  created_at?: string;
  visibility: "public" | "private";
  has_access: boolean;
}

export interface DocumentAccessRequest {
  request_id: ID;
  user_id: string;
  source_id: ID;
  filename: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  created_at: ISODate;
  decided_by?: string;
  decided_at?: ISODate;
  notes?: string;
}

export async function fetchAccessDocuments(signal?: AbortSignal): Promise<{ documents: DocumentAccessItem[] }> {
  return apiClient(ENDPOINT_DOCUMENTS, { signal });
}

export async function requestDocumentAccess(input: { source_id: ID; reason: string }, signal?: AbortSignal) {
  return apiClient<DocumentAccessRequest>(ENDPOINT_DOCUMENT_REQUEST, { method: "POST", body: input, signal });
}

export async function fetchDocumentAccessRequests(signal?: AbortSignal): Promise<{ requests: DocumentAccessRequest[] }> {
  return apiClient(ENDPOINT_DOCUMENT_REQUESTS, { signal });
}

export async function decideDocumentAccess(input: {
  request_id: ID;
  decision: "approve" | "reject";
  notes?: string;
}, signal?: AbortSignal) {
  return apiClient<DocumentAccessRequest>(ENDPOINT_DOCUMENT_DECISION, { method: "POST", body: input, signal });
}

export async function setDocumentVisibility(
  input: { source_id: ID; visibility: "public" | "private" },
  signal?: AbortSignal,
): Promise<{ source_id: ID; visibility: "public" | "private" }> {
  return apiClient(ENDPOINT_DOCUMENT_VISIBILITY, { method: "POST", body: input, signal });
}

export async function fetchAccessSchema(signal?: AbortSignal): Promise<AccessSchemaOutput> {
  return apiClient<AccessSchemaOutput>(ENDPOINT_SCHEMA, { method: "GET", signal });
}

export async function fetchAccessPreview(
  input: AccessPreviewInput,
  signal?: AbortSignal
): Promise<AccessPreviewOutput> {
  return apiClient<AccessPreviewOutput>(ENDPOINT_PREVIEW, {
    method: "GET",
    params: {
      resource_id: input.resource_id,
      limit: input.limit ?? 25,
    },
    signal,
  });
}

export async function submitAccessRequest(
  input: AccessRequestInput,
  signal?: AbortSignal
): Promise<AccessRequestOutput> {
  return apiClient<AccessRequestOutput>(ENDPOINT_REQUEST, {
    method: "POST",
    body: input,
    signal,
  });
}

export async function fetchAccessRequests(signal?: AbortSignal): Promise<AccessRequestsListOutput> {
  return apiClient<AccessRequestsListOutput>(ENDPOINT_REQUESTS, { method: "GET", signal });
}

export async function decideAccessRequest(
  input: AccessDecisionInput,
  signal?: AbortSignal
): Promise<AccessDecisionOutput> {
  return apiClient<AccessDecisionOutput>(ENDPOINT_DECISION, {
    method: "POST",
    body: input,
    signal,
  });
}
