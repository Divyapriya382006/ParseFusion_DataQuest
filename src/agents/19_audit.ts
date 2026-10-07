/**
 * Agent 19: Immutable Audit Log
 *
 * Purpose: Retrieves cryptographic ledger of system and human events, verifying Merkle chain integrity.
 * Endpoint: GET /agents/audit
 * Input Format: Query parameters { from?: ISODate; to?: ISODate; actor?: string; event_type?: string; case_id?: ID; object_id?: ID; cursor?: string }
 * Output Format: { events: AuditEvent[]; chain_valid: boolean; next_cursor?: string }
 */

import { apiClient } from "../api/client";
import type { ID, ISODate } from "../types/canonical";

export const ENDPOINT = "/agents/audit";

export interface AuditQueryInput {
  from?: ISODate;
  to?: ISODate;
  actor?: string;
  event_type?: string;
  case_id?: ID;
  object_id?: ID;
  cursor?: string;
}

export interface AuditEvent {
  event_id: ID;
  timestamp: ISODate;
  actor_id: string;
  actor_role: string;
  event_type: string;
  object_type: string;
  object_id: ID;
  details: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface AuditOutput {
  events: AuditEvent[];
  chain_valid: boolean;
  next_cursor?: string;
}

export async function fetchAuditLog(
  input: AuditQueryInput = {},
  signal?: AbortSignal
): Promise<AuditOutput> {
  return apiClient<AuditOutput>(ENDPOINT, {
    method: "GET",
    params: {
      from: input.from,
      to: input.to,
      actor: input.actor,
      event_type: input.event_type,
      case_id: input.case_id,
      object_id: input.object_id,
      cursor: input.cursor,
    },
    signal,
  });
}
