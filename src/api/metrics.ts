import { apiClient } from "./client";
import type { MetricsResponse } from "../types/api";

export const METRICS_ENDPOINT = "/metrics";

export async function fetchMetrics(signal?: AbortSignal): Promise<MetricsResponse> {
  return apiClient<MetricsResponse>(METRICS_ENDPOINT, { signal });
}
