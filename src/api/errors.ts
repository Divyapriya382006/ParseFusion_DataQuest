import type { ApiError } from "../types/canonical";

/**
 * Thrown when the backend API endpoint is unreachable, timed out, or returns a network failure/404 on an agent route.
 * Mapped in the UI to the "Backend not connected: <endpoint>" state.
 */
export class NotConnectedError extends Error {
  public readonly endpoint: string;
  public readonly status?: number;

  constructor(endpoint: string, message?: string, status?: number) {
    super(message || `Backend not connected: ${endpoint}`);
    this.name = "NotConnectedError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

/**
 * Thrown when the API returns an envelope failure { ok: false, error: ApiError, request_id }
 */
export class BackendApiError extends Error {
  public readonly apiError: ApiError;
  public readonly requestId?: string;
  public readonly status?: number;

  constructor(apiError: ApiError, requestId?: string, status?: number) {
    super(apiError.message || `API Error: ${apiError.code}`);
    this.name = "BackendApiError";
    this.apiError = apiError;
    this.requestId = requestId;
    this.status = status;
  }
}
