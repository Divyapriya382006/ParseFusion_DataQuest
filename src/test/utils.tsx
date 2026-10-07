import React from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EvidenceProvider, useEvidence } from "../context/EvidenceContext";
import { EvidenceHighlightProvider } from "../context/EvidenceHighlightContext";
import { vi } from "vitest";

/** Shows what the app-wide "open source viewer" state holds, so tests can see that a click opened it. */
export const ViewerProbe: React.FC = () => {
  const { isModalOpen, activeEvidence } = useEvidence();
  return (
    <div data-testid="viewer-probe" data-open={isModalOpen ? "true" : "false"}>
      {activeEvidence ? `${activeEvidence.source_id}|${activeEvidence.page_number}|${activeEvidence.block_id}` : ""}
    </div>
  );
};

export function renderWithApp(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EvidenceProvider>
        <EvidenceHighlightProvider>
          {ui}
          <ViewerProbe />
        </EvidenceHighlightProvider>
      </EvidenceProvider>
    </QueryClientProvider>
  );
}

/** Image stub that "loads" on the next tick and counts how many images were requested. */
export function stubImages() {
  const created: string[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    referrerPolicy = "";
    set src(value: string) {
      created.push(value);
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", FakeImage);
  return created;
}
