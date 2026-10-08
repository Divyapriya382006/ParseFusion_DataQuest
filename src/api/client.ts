import { NotConnectedError, BackendApiError } from "./errors";
import { unwrapEnvelope } from "./envelope";
import type { JobStatus } from "../types/api";

// In-memory auth token store (Rule 7: No browser storage for data / auth tokens)
let inMemoryAuthToken: string | null = null;

export function setInMemoryToken(token: string | null): void {
  inMemoryAuthToken = token;
}

export function getInMemoryToken(): string | null {
  return inMemoryAuthToken;
}

export function getApiBaseUrl(): string {
  const envUrl = import.meta.env.VITE_API_BASE_URL;
  if (typeof envUrl === "string" && envUrl.trim().length > 0) {
    return envUrl.trim().replace(/\/+$/, "");
  }
  return "";
}

export function getApiUrl(endpoint: string): string {
  const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const baseUrl = getApiBaseUrl();
  return baseUrl ? new URL(cleanEndpoint, `${baseUrl}/`).toString() : cleanEndpoint;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  isFormData?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Core HTTP client for ParseFusion agents and standard endpoints.
 * Throws NotConnectedError if the backend is not configured or unreachable.
 * Throws BackendApiError on business API errors returned in the envelope.
 */
export async function apiClient<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const baseUrl = getApiBaseUrl();

  // If baseUrl is unset, fail fast with typed NotConnectedError
  if (!baseUrl) {
    throw new NotConnectedError(
      endpoint,
      `API base URL is not configured. Set VITE_API_BASE_URL in your environment.`
    );
  }

  const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  let url = getApiUrl(cleanEndpoint);

  if (options.params) {
    const searchParams = new URLSearchParams();
    Object.entries(options.params).forEach(([key, val]) => {
      if (val !== undefined && val !== null) {
        searchParams.append(key, String(val));
      }
    });
    const queryString = searchParams.toString();
    if (queryString) {
      url += (url.includes("?") ? "&" : "?") + queryString;
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };

  if (inMemoryAuthToken) {
    headers["Authorization"] = `Bearer ${inMemoryAuthToken}`;
  }

  let body: BodyInit | undefined;
  if (options.isFormData && options.body instanceof FormData) {
    body = options.body;
    // Don't set Content-Type header so the browser sets the multipart boundary
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body,
      credentials: "include", // Supports httpOnly cookies
      signal: options.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    // Network failures, CORS errors, or host unreachable
    throw new NotConnectedError(
      cleanEndpoint,
      `Network connection failed to ${cleanEndpoint}: ${(err as Error).message}`
    );
  }

  // If 404 on an agent endpoint or bad gateway, treat as not connected
  if (response.status === 404 || response.status === 502 || response.status === 503 || response.status === 504) {
    throw new NotConnectedError(
      cleanEndpoint,
      `Endpoint returned HTTP ${response.status}: ${cleanEndpoint}`,
      response.status
    );
  }

  let jsonResult: unknown;
  try {
    jsonResult = await response.json();
  } catch {
    if (!response.ok) {
      throw new BackendApiError(
        { code: `HTTP_${response.status}`, message: `Server error HTTP ${response.status}` },
        undefined,
        response.status
      );
    }
    throw new NotConnectedError(
      cleanEndpoint,
      `Response could not be parsed as JSON: ${cleanEndpoint}`
    );
  }

  const { data } = unwrapEnvelope<T>(jsonResult);
  return data;
}

/**
 * Polls a long-running job until completion or failure.
 * Interval defaults to pollIntervalMs or 2000ms.
 */
export async function pollJob<TResult = unknown>(
  jobId: string,
  pollIntervalMs = 2000,
  onProgress?: (job: JobStatus<TResult>) => void,
  signal?: AbortSignal
): Promise<JobStatus<TResult>> {
  while (!signal?.aborted) {
    const job = await apiClient<JobStatus<TResult>>(`/jobs/${jobId}`, { signal });
    if (onProgress) {
      onProgress(job);
    }

    if (job.status === "completed" || job.status === "failed") {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Job polling aborted");
}
