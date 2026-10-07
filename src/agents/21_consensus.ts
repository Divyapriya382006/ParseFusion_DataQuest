/**
 * Agent 21: Extractor Consensus & Coverage
 *
 * Purpose: Evaluates parser jury agreement across parallel extractors, identifies winner candidates,
 * escalates disputed extractions for review, and maps uncovered document regions.
 * Endpoint: POST /agents/consensus
 * Input Format: { source_id: ID; page_number?: number; block_id?: ID }
 * Output Format: { blocks: ConsensusBlock[]; coverage: PageCoverage[] }
 */

import { apiClient } from "../api/client";
import type { ID, Alternative, BoundingBox } from "../types/canonical";

export const ENDPOINT = "/agents/consensus";

export interface ConsensusInput {
  source_id: ID;
  page_number?: number;
  block_id?: ID;
}

export interface ConsensusBlock {
  block_id: ID;
  winner: string;
  agreement: string;
  candidates: Alternative[];
  escalated: boolean;
  needs_review: boolean;
}

export interface PageCoverage {
  page_number: number;
  coverage_score: number;
  uncovered_regions: BoundingBox[];
}

export interface ConsensusOutput {
  blocks: ConsensusBlock[];
  coverage: PageCoverage[];
}

export async function evaluateConsensus(
  input: ConsensusInput,
  signal?: AbortSignal
): Promise<ConsensusOutput> {
  return apiClient<ConsensusOutput>(ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
