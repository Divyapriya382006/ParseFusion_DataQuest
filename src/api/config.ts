import { apiClient } from "./client";
import type { AppConfig } from "../types/api";

export const CONFIG_ENDPOINT = "/config";

export async function fetchAppConfig(signal?: AbortSignal): Promise<AppConfig> {
  return apiClient<AppConfig>(CONFIG_ENDPOINT, { signal });
}
