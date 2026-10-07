/**
 * Agent 01: File Validation
 *
 * Purpose: Inspects incoming file binary, sanitizes filenames, computes SHA-256 hash,
 * detects MIME type, inspects password encryption, detects duplicates, and validates file boundaries.
 * Endpoint: POST /agents/file-validation
 * Input Format: Multipart FormData containing `file` binary and optional `options` JSON string.
 * Output Format: Validated file metadata envelope unwrapped into FileValidationOutput.
 */

import { apiClient } from "../api/client";
import type { ID, ApiError } from "../types/canonical";

export const ENDPOINT = "/agents/file-validation";

export interface FileValidationInput {
  file: File;
  options?: {
    password?: string;
  };
}

export interface FileValidationOutput {
  source_id: ID;
  sanitized_filename: string;
  sha256: string;
  detected_mime: string;
  size_bytes: number;
  page_count?: number;
  status: "accepted" | "rejected";
  error?: ApiError;
  duplicate_of?: ID;
}

export async function validateFile(
  input: FileValidationInput,
  signal?: AbortSignal
): Promise<FileValidationOutput> {
  const formData = new FormData();
  formData.append("file", input.file);
  if (input.options) {
    formData.append("options", JSON.stringify(input.options));
  }

  return apiClient<FileValidationOutput>(ENDPOINT, {
    method: "POST",
    body: formData,
    isFormData: true,
    signal,
  });
}
