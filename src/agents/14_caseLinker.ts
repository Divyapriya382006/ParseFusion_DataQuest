/**
 * Agent 14: Case Linker
 *
 * Purpose: Associates documents to investigation cases via explicit binding or fuzzy metadata signals, with human verification loop.
 * Endpoint: POST /agents/case-linker and POST /agents/case-linker/decision
 * Input Format: { case_id: ID; source_ids: ID[]; mode: "explicit" | "suggest" }
 * Output Format: { links: CaseLink[] }
 */

import { apiClient } from "../api/client";
import type { ID, ISODate } from "../types/canonical";

export const ENDPOINT = "/agents/case-linker";
export const DECISION_ENDPOINT = "/agents/case-linker/decision";

export interface CaseLinkerInput {
  case_id: ID;
  source_ids: ID[];
  mode: "explicit" | "suggest";
}

export interface CaseLink {
  link_id: ID;
  case_id: ID;
  source_id: ID;
  relationship_type: string;
  relationship_confidence: number;
  matching_signals: string[];
  linked_by: string;
  linked_at: ISODate;
  human_verified: boolean;
}

export interface CaseLinkerOutput {
  links: CaseLink[];
}

export interface CaseLinkDecisionInput {
  link_id: ID;
  decision: "confirm" | "reject";
}

export interface CaseLinkDecisionOutput {
  link_id: ID;
  human_verified: boolean;
}

export async function linkCaseDocuments(
  input: CaseLinkerInput,
  signal?: AbortSignal
): Promise<CaseLinkerOutput> {
  return apiClient<CaseLinkerOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}

export async function decideCaseLink(
  input: CaseLinkDecisionInput,
  signal?: AbortSignal
): Promise<CaseLinkDecisionOutput> {
  return apiClient<CaseLinkDecisionOutput>(DECISION_ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
