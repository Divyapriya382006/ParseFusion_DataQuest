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
    await waitFor(() => expect(screen.getByText("Findings for review")).toBeInTheDocument());
    expect(screen.getByText("Case score")).toBeInTheDocument();
    expect(screen.getByText("Parsing output per document")).toBeInTheDocument();
    expect(screen.getByText("Normalized facts")).toBeInTheDocument();
    expect(screen.getByText("Cross-document reasoning")).toBeInTheDocument();
    expect(screen.getAllByText("invoice.pdf").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Potential discrepancy: salary/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Bases differ: gross vs net/).length).toBeGreaterThan(0);
    expect(screen.getByText(/mean of finding scores/)).toBeInTheDocument();
    expect(screen.getByText(/How related are the documents/)).toBeInTheDocument();
    expect(screen.getByText(/Inputs: parsing output and score of each document/)).toBeInTheDocument();
    expect(screen.getByText(/comparable \+ not comparable = pairs considered/)).toBeInTheDocument();
  });

  it("shows 'Not scored' with the reason instead of 0% when nothing was comparable", async () => {
    const api = await import("../api/caseAnalysis");
    vi.mocked(api.getCaseAnalysis).mockResolvedValueOnce(fixture.not_scored as never);
    renderWithApp(
      <MemoryRouter>
        <CaseAnalysisPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("Not scored")).toBeInTheDocument());
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.getAllByText(/no named (subject|entity)/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Pairing funnel/)).toBeInTheDocument();
    expect(screen.getByText(/Attribute overlap/)).toBeInTheDocument();
    expect(screen.getAllByText(/SUBJECT_MISSING/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/No facts:|unclassified numbers/).length).toBeGreaterThan(0);
  });

  it("shows an older analysis that reported 0 as not scored (a dash), never 0%", async () => {
    const api = await import("../api/caseAnalysis");
    const legacy = {
      case_id: "c1", analyzed_at: "2026-10-08T00:00:00Z", stages: [],
      final: { verdict: "insufficient_data", confidence: 0, documents: 3, facts: 34, comparisons: 0, findings: 0,
               summary: "No values could be compared across the documents" },
    };
    vi.mocked(api.getCaseAnalysis).mockResolvedValueOnce(legacy as never);
    renderWithApp(
      <MemoryRouter>
        <CaseAnalysisPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("Not scored")).toBeInTheDocument());
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.getByText(/older version/)).toBeInTheDocument();
  });
});
