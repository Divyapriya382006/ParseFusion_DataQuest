import React from "react";
import { screen, waitFor } from "@testing-library/react";
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

vi.mock("../api/batches", () => ({
  listBatches: vi.fn(async () => ({ batches: [batch] })),
  getBatch: vi.fn(async () => batch),
  retryBatchSource: vi.fn(),
  analyzeBatch: vi.fn(),
}));
vi.mock("../api/sources", () => ({
  getSourceDocument: vi.fn(async () => ({ source_id: "x", pages: [] })),
  getSourcePage: vi.fn(),
  listSources: vi.fn(async () => ({ sources: [] })),
}));
vi.mock("../api/caseAnalysis", () => ({ getCaseAnalysis: vi.fn(async () => fixture.analysis) }));

describe("BatchProgressPage", () => {
  it("lists every batch with per-document parsing output, cross-document reasoning and the final output", async () => {
    renderWithApp(
      <MemoryRouter initialEntries={["/batch"]}>
        <BatchProgressPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("bat_1")).toBeInTheDocument());
    expect(screen.getByText(/Parsing output per document/)).toBeInTheDocument();
    expect(screen.getAllByText("invoice.pdf").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText("Normalized facts")).toBeInTheDocument());
    expect(screen.getByText("Cross-document reasoning")).toBeInTheDocument();
    expect(screen.getByText("Final output")).toBeInTheDocument();
    expect(screen.getByText("Findings for review")).toBeInTheDocument();
    expect(screen.getByText("Case score")).toBeInTheDocument();
  });
});
