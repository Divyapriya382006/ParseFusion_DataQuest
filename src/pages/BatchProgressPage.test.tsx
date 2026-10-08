import React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import fixture from "../test/caseAnalysis.fixture.json";
import { renderWithApp } from "../test/utils";
import { BatchProgressPage } from "./BatchProgressPage";

const parsing = fixture.analysis.stages[0].output as Array<Record<string, unknown>>;

const batch = {
  batch_id: "bat_1",
  job_id: "job_1",
  created_at: "2026-10-08T02:00:00Z",
  status: "completed",
  stage: "completed",
  progress_percent: 100,
  source_ids: parsing.map((p) => p.source_id as string),
  sources_summary: { total: parsing.length, completed: parsing.length, failed: 0 },
  case_id: fixture.case.case_id,
  sources: parsing.map((p) => ({ source_id: p.source_id, filename: p.filename, status: "completed", stage: "completed", error: null, parse: p })),
  analysis: { status: "completed", case_id: fixture.case.case_id, analyzed_at: fixture.analysis.analyzed_at, final: fixture.analysis.final },
};

const row = {
  batch_id: "bat_1", created_at: batch.created_at, status: "completed", stage: "completed", progress_percent: 100,
  documents: parsing.map((p) => ({ source_id: p.source_id, filename: p.filename, status: "completed", unread_pages: 0 })),
  document_count: parsing.length, score: 0.97, warnings_count: 2, export_status: "ready", export_errors: [],
  analysis_status: "completed", unread_pages: 0, archived: false,
};

vi.mock("../api/batches", () => ({
  listBatchSummaries: vi.fn(async () => ({ total: 1, offset: 0, limit: 10, batches: [row] })),
  archiveBatch: vi.fn(),
  deleteBatch: vi.fn(),
  getBatch: vi.fn(async () => batch),
  retryBatchSource: vi.fn(),
  analyzeBatch: vi.fn(),
}));
vi.mock("../api/sources", () => ({
  getSourceDocument: vi.fn(async () => ({ source_id: "x", pages: [] })),
  getSourcePage: vi.fn(),
  listSources: vi.fn(async () => ({ sources: [] })),
}));
vi.mock("../api/cases", () => ({ listCases: vi.fn(async () => ({ cases: [fixture.case] })) }));
vi.mock("../api/caseAnalysis", () => ({
  getCaseAnalysis: vi.fn(async () => fixture.analysis),
  analyzeCase: vi.fn(async () => fixture.analysis),
  attachSourcesToCase: vi.fn(),
}));

describe("BatchProgressPage", () => {
  it("keeps case analysis available as a tab in the consolidated workspace", async () => {
    renderWithApp(
      <MemoryRouter initialEntries={["/batch"]}>
        <BatchProgressPage />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole("tab", { name: "Case Analysis" }));
    await waitFor(() => expect(screen.getByText("Run analysis")).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "Case Analysis" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Batch Pipeline" })).toHaveAttribute("aria-selected", "false");
  });

  it("lists every batch with per-document parsing output, cross-document reasoning and the final output", async () => {
    renderWithApp(
      <MemoryRouter initialEntries={["/batch"]}>
        <BatchProgressPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("bat_1")).toBeInTheDocument());
    // collapsed by default: no detail until the row is opened
    expect(screen.queryByText(/Parsing output per document/)).not.toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Expand batch"));
    await waitFor(() => expect(screen.getByText(/Parsing output per document/)).toBeInTheDocument());
    expect(screen.getAllByText("invoice.pdf").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText("Normalized facts")).toBeInTheDocument());
    expect(screen.getByText("Cross-document reasoning")).toBeInTheDocument();
    expect(screen.getByText("Final output")).toBeInTheDocument();
    expect(screen.getByText(/Final parse: union of all document parses/)).toBeInTheDocument();
    expect(screen.getByText("Findings for review")).toBeInTheDocument();
    expect(screen.getByText("Case score")).toBeInTheDocument();
  });
});
