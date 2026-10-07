import { apiClient } from "./client";
import type { HealthResponse } from "../types/api";

export const HEALTH_AGENTS_ENDPOINT = "/health/agents";

export async function fetchAgentHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiClient<HealthResponse>(HEALTH_AGENTS_ENDPOINT, { signal });
}
