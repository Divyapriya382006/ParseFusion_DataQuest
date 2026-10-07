/**
 * Agent 18: Human Approval Gateway
 *
 * Purpose: Applies a human decision to a proposed action. The backend decides whether the transition is valid;
 * the frontend only sends the decision and renders the returned state.
 * Endpoint: POST /agents/human-approval
 * Input Format: HumanApprovalInput
 * Output Format: HumanApprovalOutput
 */

import { apiClient } from "../api/client";
import type { ID, ISODate, ProposedAction } from "../types/canonical";

export const ENDPOINT = "/agents/human-approval";

export type ApprovalDecision =
  | "save_edit"
  | "submit_review"
  | "approve"
  | "reject"
  | "cancel"
  | "execute";

export interface HumanApprovalInput {
  action_id: ID;
  decision: ApprovalDecision;
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
  content_hash?: string;
}

export interface ApprovalSignature {
  signed_by: string;
  algorithm: string;
  value: string;
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
  return apiClient<HumanApprovalOutput>(ENDPOINT, { method: "POST", body: input, signal });
}
