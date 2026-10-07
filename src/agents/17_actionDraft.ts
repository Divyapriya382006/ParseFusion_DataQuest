/**
 * Agent 17: Action Draft Agent
 *
 * Purpose: Prepares structured, policy-checked action proposals (e.g. clarification email, information request, audit note)
 * anchored to supporting evidence for human operator approval.
 * Endpoint: POST /agents/action-draft
 * Input Format: { case_id: ID; finding_id?: ID; action_type: string }
 * Output Format: ProposedAction
 */

import { apiClient } from "../api/client";
import type { ID, ProposedAction } from "../types/canonical";

export const ENDPOINT = "/agents/action-draft";

export interface ActionDraftInput {
  case_id: ID;
  finding_id?: ID;
  action_type: string;
}

export type ActionDraftOutput = ProposedAction;

export async function draftAction(
  input: ActionDraftInput,
  signal?: AbortSignal
): Promise<ActionDraftOutput> {
  return apiClient<ActionDraftOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
