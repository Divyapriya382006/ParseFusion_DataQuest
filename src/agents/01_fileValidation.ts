/**
 * Agent 01: File Validation
 *
 * Purpose: Detects the real file type from content, hashes the file, enforces limits and returns a typed result.
 * Endpoint: POST /agents/file-validation  (multipart/form-data)
 * Input Format: { file: File; password?: string }
 * Output Format: FileValidationOutput
 */

import { apiClient } from "../api/client";
import type { ID, ApiError, WarningItem } from "../types/canonical";

export const ENDPOINT = "/agents/file-validation";

export interface FileValidationInput {
  file: File;
  /** Optional password for protected files (sent as the `password` form field). */
  password?: string;
}

export interface FileValidationOutput {
  source_id: ID;
  sanitized_filename: string;
  sha256: string;
  detected_mime: string;
  size_bytes: number;
  page_count?: number | null;
  status: "accepted" | "rejected";
  duplicate_of?: ID | null;
  error?: ApiError;
  warnings?: WarningItem[];
}

export async function validateFile(
  input: FileValidationInput,
  signal?: AbortSignal
): Promise<FileValidationOutput> {
  const form = new FormData();
  form.append("file", input.file);
  if (input.password) form.append("password", input.password);
  return apiClient<FileValidationOutput>(ENDPOINT, {
    method: "POST",
    body: form,
    isFormData: true,
    signal,
  });
}