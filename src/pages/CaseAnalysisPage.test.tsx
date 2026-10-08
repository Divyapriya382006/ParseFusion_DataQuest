import React from "react";
import { screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import fixture from "../test/caseAnalysis.fixture.json";
import { renderWithApp } from "../test/utils";
import { CaseAnalysisPage } from "./CaseAnalysisPage";

vi.mock("../api/cases", () => ({ listCases: vi.fn(async () => ({ cases: [fixture.case] })) }));
vi.mock("../api/sources", () => ({ listSources: vi.fn(async () => ({ sources: [] })), getSourcePage: vi.fn() }));
vi.mock("../api/caseAnalysis", () => ({
  getCaseAnalysis: vi.fn(async () => fixture.analysis),
  analyzeCase: vi.fn(async () => fixture.analysis),
  attachSourcesToCase: vi.fn(),
}));

describe("CaseAnalysisPage", () => {
  it("shows every stage and the final result with its confidence, from backend output", async () => {
    renderWithApp(
      <MemoryRouter>
        <CaseAnalysisPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("Discrepancies found")).toBeInTheDocument());
    expect(screen.getByText("Final confidence")).toBeInTheDocument();
    expect(screen.getByText("Parsing output per document")).toBeInTheDocument();
    expect(screen.getByText("Normalized facts")).toBeInTheDocument();
    expect(screen.getByText("Cross-document reasoning")).toBeInTheDocument();
    expect(screen.getAllByText("invoice.pdf").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Potential discrepancy: salary/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Bases differ: gross vs net/)).toBeInTheDocument();
    expect(screen.getByText(/mean confidence of the findings/)).toBeInTheDocument();
  });
});
