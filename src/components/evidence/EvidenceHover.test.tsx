import React from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceHover } from "./EvidenceHover";
import { makeEvidence, makePage } from "../../test/fixtures";
import { renderWithApp, stubImages } from "../../test/utils";

vi.mock("../../api/sources", () => ({
  getSourcePage: vi.fn(),
}));
import { getSourcePage } from "../../api/sources";

const mockedGetPage = vi.mocked(getSourcePage);

async function flush() {
  await act(async () => {
    // react-query notifies through setTimeout(0), so fake timers must be nudged as well as microtasks
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5);
      await Promise.resolve();
    }
  });
}

async function openByHover(trigger: HTMLElement) {
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  await flush();
}

describe("EvidenceHover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedGetPage.mockReset();
    mockedGetPage.mockResolvedValue(makePage());
    stubImages();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens after 300 ms of hover and shows file, page, method, confidence, excerpt and thumbnail", async () => {
    renderWithApp(<EvidenceHover evidence={makeEvidence()}>5,000</EvidenceHover>);
    const trigger = screen.getByText("5,000");

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();

    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("income_certificate.pdf");
    expect(tip).toHaveTextContent("Page 3");
    expect(tip).toHaveTextContent("native_text"); // method comes from the page's block
    expect(tip).toHaveTextContent("0.91"); // confidence as received
    expect(screen.getByTestId("evidence-excerpt")).toHaveTextContent("Total 5,000");
    expect(screen.getByTestId("evidence-thumbnail")).toHaveAttribute("data-has-highlight", "true");
    expect(trigger.closest("[data-evidence-anchor]")).toHaveAttribute("aria-describedby", tip.id);
  });

  it("cancels a pending open when the pointer leaves", async () => {
    renderWithApp(<EvidenceHover evidence={makeEvidence()}>5,000</EvidenceHover>);
    const trigger = screen.getByText("5,000");
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(mockedGetPage).not.toHaveBeenCalled();
  });

  it("is reachable by keyboard: focus opens, Esc closes, Enter opens the source viewer", async () => {
    renderWithApp(<EvidenceHover evidence={makeEvidence()}>5,000</EvidenceHover>);
    const trigger = screen.getByRole("button", { name: "5,000" });
    expect(trigger).toHaveAttribute("tabindex", "0");

    fireEvent.focus(trigger);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.keyDown(trigger, { key: "Enter" });
    const probe = screen.getByTestId("viewer-probe");
    expect(probe).toHaveAttribute("data-open", "true");
    expect(probe).toHaveTextContent("src_1|3|blk_1");
  });

  it("opens the source viewer when the popover is clicked", async () => {
    renderWithApp(<EvidenceHover evidence={makeEvidence()}>5,000</EvidenceHover>);
    await openByHover(screen.getByText("5,000"));
    fireEvent.click(screen.getByRole("tooltip"));
    expect(screen.getByTestId("viewer-probe")).toHaveAttribute("data-open", "true");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("with no bbox shows the whole page, no highlight box, and the reason from the backend", async () => {
    const ev = makeEvidence({ block_id: "blk_nobox", bbox: null });
    renderWithApp(<EvidenceHover evidence={ev}>scribble</EvidenceHover>);
    await openByHover(screen.getByText("scribble"));
    expect(screen.getByTestId("evidence-thumbnail")).toHaveAttribute("data-has-highlight", "false");
    expect(screen.queryByTestId("evidence-thumbnail-box")).toBeNull();
    // reason is read from the page's block because the evidence did not carry it
    expect(screen.getByTestId("evidence-bbox-note")).toHaveTextContent("Handwritten region could not be located");
  });

  it("prefers bbox_unavailable_reason carried by the evidence", async () => {
    const ev = makeEvidence({ bbox: null, bbox_unavailable_reason: "Scanned at low resolution" });
    renderWithApp(<EvidenceHover evidence={ev}>x</EvidenceHover>);
    await openByHover(screen.getByText("x"));
    expect(screen.getByTestId("evidence-bbox-note")).toHaveTextContent("Scanned at low resolution");
  });

  it("restricted values show a restricted message only: no excerpt, no thumbnail, no fetch, no navigation", async () => {
    renderWithApp(
      <EvidenceHover evidence={makeEvidence({ locked: true })}>
        <span>hidden</span>
      </EvidenceHover>
    );
    const trigger = screen.getByText("hidden");
    await openByHover(trigger);
    expect(screen.getByTestId("evidence-restricted")).toHaveTextContent(/restricted/i);
    expect(screen.queryByTestId("evidence-excerpt")).toBeNull();
    expect(screen.queryByTestId("evidence-thumbnail")).toBeNull();
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("income_certificate.pdf");
    expect(mockedGetPage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tooltip"));
    fireEvent.click(trigger);
    expect(screen.getByTestId("viewer-probe")).toHaveAttribute("data-open", "false");
  });

  it("masked values behave like locked ones", async () => {
    renderWithApp(<EvidenceHover evidence={makeEvidence({ masked: true })}>m</EvidenceHover>);
    await openByHover(screen.getByText("m"));
    expect(screen.getByTestId("evidence-restricted")).toBeInTheDocument();
    expect(mockedGetPage).not.toHaveBeenCalled();
  });

  it("fetches the page once and loads the image once, however often it is hovered", async () => {
    const created = stubImages();
    renderWithApp(<EvidenceHover evidence={makeEvidence()}>5,000</EvidenceHover>);
    const trigger = screen.getByText("5,000");
    await openByHover(trigger);
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    await openByHover(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(mockedGetPage).toHaveBeenCalledTimes(1);
    expect(created.filter((s) => s === "/images/page_1.png")).toHaveLength(1);
  });

  it("does not fetch the page when the evidence carries everything (crop_url + method)", async () => {
    const ev = makeEvidence({ crop_url: "/crops/c1.png", extraction_method: "ocr_tesseract" });
    renderWithApp(<EvidenceHover evidence={ev}>c</EvidenceHover>);
    await openByHover(screen.getByText("c"));
    expect(mockedGetPage).not.toHaveBeenCalled();
    expect(screen.getByTestId("evidence-crop")).toHaveAttribute("src", "/crops/c1.png");
    expect(screen.getByRole("tooltip")).toHaveTextContent("ocr_tesseract");
  });

  it("uses page data the caller already has instead of fetching", async () => {
    renderWithApp(
      <EvidenceHover evidence={makeEvidence()} pageData={makePage()}>
        v
      </EvidenceHover>
    );
    await openByHover(screen.getByText("v"));
    expect(mockedGetPage).not.toHaveBeenCalled();
    expect(screen.getByTestId("evidence-thumbnail")).toBeInTheDocument();
  });

  it("touch: first tap shows the popover, second tap opens the viewer", async () => {
    renderWithApp(<EvidenceHover evidence={makeEvidence()}>5,000</EvidenceHover>);
    const trigger = screen.getByText("5,000");

    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);
    await flush();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-probe")).toHaveAttribute("data-open", "false");

    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);
    expect(screen.getByTestId("viewer-probe")).toHaveAttribute("data-open", "true");
  });

  it("touch: a tap elsewhere closes the popover", async () => {
    renderWithApp(
      <div>
        <EvidenceHover evidence={makeEvidence()}>5,000</EvidenceHover>
        <p>elsewhere</p>
      </div>
    );
    const trigger = screen.getByText("5,000");
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);
    await flush();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText("elsewhere"), { pointerType: "touch" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders children untouched when there is no evidence", () => {
    renderWithApp(<EvidenceHover evidence={undefined}>plain</EvidenceHover>);
    expect(screen.getByText("plain")).not.toHaveAttribute("data-evidence-anchor");
  });

  it("a wrapped button keeps its own click and wrapper focus handling still works", async () => {
    const onClick = vi.fn();
    renderWithApp(
      <EvidenceHover evidence={makeEvidence()} focusable={false} openOnClick={false}>
        <button type="button" onClick={onClick}>
          chip
        </button>
      </EvidenceHover>
    );
    const chip = screen.getByRole("button", { name: "chip" });
    fireEvent.focus(chip);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("waitFor sanity: popover content is data from the backend only", async () => {
    mockedGetPage.mockResolvedValue(makePage({ image_url: "/images/other.png" }));
    renderWithApp(<EvidenceHover evidence={makeEvidence({ filename: "other.pdf" })}>z</EvidenceHover>);
    await openByHover(screen.getByText("z"));
    expect(screen.getByTestId("evidence-thumbnail")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("other.pdf");
  });
});
