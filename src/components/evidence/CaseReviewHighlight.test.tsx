import React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HighlightScope } from "./HighlightScope";
import { HighlightedPagesPreview } from "./HighlightedPagesPreview";
import { makeEvidence, makePage } from "../../test/fixtures";
import { renderWithApp, stubImages } from "../../test/utils";

vi.mock("../../api/sources", () => ({ getSourcePage: vi.fn() }));
import { getSourcePage } from "../../api/sources";

describe("Case Review highlight", () => {
  beforeEach(() => {
    vi.mocked(getSourcePage).mockReset();
    vi.mocked(getSourcePage).mockImplementation(async (sourceId: string, pageNumber: number) =>
      makePage({ source_id: sourceId, page_number: pageNumber, page_id: `${sourceId}_${pageNumber}`, image_url: `/img/${sourceId}.png` })
    );
    stubImages();
  });

  it("hovering a fact draws all its evidence boxes at once, each labelled by its document", async () => {
    const evidences = [
      makeEvidence({ source_id: "src_1", filename: "income_certificate.pdf", page_number: 1 }),
      makeEvidence({ source_id: "src_2", filename: "bank_statement.pdf", page_number: 2, bbox: [10, 20, 110, 80] }),
    ];
    renderWithApp(
      <div>
        <HighlightScope evidences={evidences}>
          <span>fact card</span>
        </HighlightScope>
        <HighlightedPagesPreview />
      </div>
    );
    expect(screen.getByTestId("highlighted-pages-empty")).toBeInTheDocument();

    fireEvent.pointerEnter(screen.getByText("fact card").parentElement!, { pointerType: "mouse" });
    await waitFor(() => expect(screen.getAllByTestId("highlight-box")).toHaveLength(2));
    expect(screen.getAllByTestId("highlighted-page")).toHaveLength(2);
    expect(screen.getAllByText("income_certificate.pdf").length).toBeGreaterThan(0);
    expect(screen.getAllByText("bank_statement.pdf").length).toBeGreaterThan(0);

    fireEvent.pointerLeave(screen.getByText("fact card").parentElement!, { pointerType: "mouse" });
    await waitFor(() => expect(screen.queryAllByTestId("highlight-box")).toHaveLength(0));
  });

  it("restricted evidence is never drawn", async () => {
    renderWithApp(
      <div>
        <HighlightScope evidences={[makeEvidence({ locked: true })]}>
          <span>locked fact</span>
        </HighlightScope>
        <HighlightedPagesPreview />
      </div>
    );
    fireEvent.pointerEnter(screen.getByText("locked fact").parentElement!, { pointerType: "mouse" });
    expect(screen.getByTestId("highlighted-pages-empty")).toBeInTheDocument();
    expect(getSourcePage).not.toHaveBeenCalled();
  });

  it("shows the first available evidence page before the user hovers a fact", async () => {
    renderWithApp(
      <HighlightedPagesPreview fallbackEvidence={[makeEvidence({ source_id: "src_1", filename: "invoice.pdf" })]} />
    );
    await waitFor(() => expect(screen.getAllByTestId("highlight-box")).toHaveLength(1));
    expect(screen.getAllByText("invoice.pdf").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("highlighted-pages-empty")).not.toBeInTheDocument();
  });
});
