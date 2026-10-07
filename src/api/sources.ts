import { apiClient } from "./client";
import type { SourceDocument, PageUnit, ID } from "../types/canonical";

export async function getSourceDocument(sourceId: ID, signal?: AbortSignal): Promise<SourceDocument> {
  return apiClient<SourceDocument>(`/sources/${sourceId}`, { signal });
}

export async function getSourcePage(
  sourceId: ID,
  pageNumber: number,
  signal?: AbortSignal
): Promise<PageUnit> {
  return apiClient<PageUnit>(`/sources/${sourceId}/pages/${pageNumber}`, { signal });
}

export async function listSources(signal?: AbortSignal): Promise<{ sources: SourceDocument[] }> {
  return apiClient<{ sources: SourceDocument[] }>("/sources", { signal });
}
