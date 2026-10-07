/**
 * Agent 24: Governed Natural Language SQL Assistant
 *
 * Purpose: Converts natural language questions into governed SQL queries, checks security guardrails (ALLOW, CONFIRM, BLOCK),
 * executes against permitted columns, formats tabular answers, and attaches evidence citations.
 * Endpoint: POST /agents/chat-sql
 * Input Format: { question: string; conversation_id?: ID; scope?: { resource_ids?: ID[]; case_id?: ID } }
 * Output Format: ChatSqlOutput
 */

import { apiClient } from "../api/client";
import type { ID, EvidenceReference, ApiError } from "../types/canonical";

export const ENDPOINT = "/agents/chat-sql";

export interface ChatSqlInput {
  question: string;
  conversation_id?: ID;
  scope?: {
    resource_ids?: ID[];
    case_id?: ID;
  };
}

export interface SqlQueryAnalysis {
  operation: string;
  tables: string[];
  columns: string[];
  where?: string;
  estimated_rows?: number;
}

export interface SqlResultColumn {
  name: string;
  locked: boolean;
}

export interface ChatSqlOutput {
  conversation_id: ID;
  sql?: string;
  analysis?: SqlQueryAnalysis;
  decision: "ALLOW" | "CONFIRM" | "BLOCK";
  reason?: string;
  approval_id?: ID;
  columns?: SqlResultColumn[];
  rows?: unknown[][];
  answer_text?: string;
  citations?: EvidenceReference[];
  error?: ApiError;
}

export async function askChatSql(
  input: ChatSqlInput,
  signal?: AbortSignal
): Promise<ChatSqlOutput> {
  return apiClient<ChatSqlOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
