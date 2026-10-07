import { apiClient, setInMemoryToken } from "./client";
import type { UserProfile } from "../types/api";

export const AUTH_ME_ENDPOINT = "/auth/me";

export async function fetchCurrentUser(signal?: AbortSignal): Promise<UserProfile> {
  return apiClient<UserProfile>(AUTH_ME_ENDPOINT, { signal });
}

export function saveSessionToken(token: string | null): void {
  setInMemoryToken(token);
}
