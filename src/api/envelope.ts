import type { ApiResponse } from "../types/api";
import { BackendApiError } from "./errors";

export function unwrapEnvelope<T>(envelope: unknown): { data: T; requestId: string } {
  if (
    typeof envelope === "object" &&
    envelope !== null &&
    "ok" in envelope
  ) {
    const res = envelope as ApiResponse<T>;
    if (res.ok === true) {
      return { data: res.data, requestId: res.request_id };
    }
    if (res.ok === false) {
      throw new BackendApiError(res.error, res.request_id);
    }
  }

  // If response is direct data without envelope wrapper (for permissive backends), return directly
  return { data: envelope as T, requestId: "" };
}
