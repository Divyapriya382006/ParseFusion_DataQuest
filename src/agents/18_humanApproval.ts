/**
 * Agent 18: Human Approval Gateway
 *
 * Purpose: Records human governance decisions, executes state transitions (edit, review, approve, reject, execute),
 * tracks cryptographic audit signatures, and timestamps lifecycle events.
 * Endpoint: POST /agents/human-approval
 * Input Format: { action_id: ID; decision: "save_edit" | "submit_review" | "approve" | "reject" | "cancel" | "execute"; notes?: string; edited_fields?: Record<string, unknown>; rejection_reason?: string }
 * Output Format: { action: ProposedAction; event: ApprovalEvent; signature?: ApprovalSignature }
 */

import { apiClient } from "../api/client";
import type { ID, ISODate, ProposedAction } from "../types/canonical";

export const ENDPOINT = "/agents/human-approval";

export interface HumanApprovalInput {
  action_id: ID;
  decision: "save_edit" | "submit_review" | "approve" | "reject" | "cancel" | "execute";
  notes?: string;
  edited_fields?: Record<string, unknown>;
  rejection_reason?: string;
}

export interface ApprovalEvent {
  event_id: ID;
  actor_id: string;
  actor_role: string;
  event_type: string;
  event_timestamp: ISODate;
  previous_status: string;
  new_status: string;
  notes?: string;
  edited_fields?: string[];
  content_hash?: string;
}

export interface ApprovalSignature {
  signed_by: string;
  algorithm: string;
  value: string;
  expires_at?: ISODate;
}

export interface HumanApprovalOutput {
  action: ProposedAction;
  event: ApprovalEvent;
  signature?: ApprovalSignature;
}

export async function submitHumanApproval(
  input: HumanApprovalInput,
  signal?: AbortSignal
): Promise<HumanApprovalOutput> {
  return apiClient<HumanApprovalOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
