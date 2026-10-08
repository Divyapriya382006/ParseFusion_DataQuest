import { describe, expect, it } from "vitest";
import {
  computePopoverPosition,
  computeThumbnail,
  evidenceFromDetails,
  getCachedThumbnail,
  isRestricted,
  isValidBbox,
  toHighlightBoxes,
} from "./evidence";
import { makeEvidence } from "../test/fixtures";

describe("computeThumbnail", () => {
  it("crops the bbox with context and scales from page_width/page_height", () => {
    const g = computeThumbnail([100, 200, 300, 260], 1000, 1400, { maxWidth: 256, maxHeight: 144 })!;
    // region = bbox padded by max(12, 25% of size): x 50..350, y 185..275 -> 300 x 90
    expect(g.width / g.height).toBeCloseTo(300 / 90, 5);
    const scale = Math.min(256 / 300, 144 / 90);
    expect(g.backgroundWidth).toBeCloseTo(1000 * scale, 5);
    expect(g.backgroundHeight).toBeCloseTo(1400 * scale, 5);
    expect(g.backgroundX).toBeCloseTo(-50 * scale, 5);
    expect(g.backgroundY).toBeCloseTo(-185 * scale, 5);
    expect(g.highlight!.left).toBeCloseTo(50 * scale, 5);
    expect(g.highlight!.top).toBeCloseTo(15 * scale, 5);
    expect(g.highlight!.width).toBeCloseTo(200 * scale, 5);
  });

  it("shows the whole page with no highlight when bbox is null", () => {
    const g = computeThumbnail(null, 1000, 1400)!;
    expect(g.highlight).toBeNull();
    expect(g.backgroundX).toBe(0);
    expect(g.backgroundY).toBe(0);
    expect(g.width / g.height).toBeCloseTo(1000 / 1400, 5);
  });

  it("clamps a bbox that leaves the page and rejects bad page sizes", () => {
    const g = computeThumbnail([-50, -50, 2000, 2000], 1000, 1400)!;
    expect(g.highlight!.left).toBeGreaterThanOrEqual(0);
    expect(computeThumbnail([1, 1, 2, 2], 0, 100)).toBeNull();
  });

  it("caches the geometry per (page, bbox)", () => {
    const a = getCachedThumbnail("p1", [1, 2, 30, 40], 100, 200);
    const b = getCachedThumbnail("p1", [1, 2, 30, 40], 100, 200);
    expect(a).toBe(b);
    expect(getCachedThumbnail("p1", [1, 2, 31, 40], 100, 200)).not.toBe(a);
  });
});

describe("helpers", () => {
  it("validates boxes", () => {
    expect(isValidBbox([1, 2, 3, 4])).toBe(true);
    expect(isValidBbox([3, 2, 1, 4])).toBe(false);
    expect(isValidBbox(null)).toBe(false);
    expect(isValidBbox([1, 2, 3])).toBe(false);
  });

  it("treats locked or masked evidence as restricted and never boxes it", () => {
    expect(isRestricted(makeEvidence({ locked: true }))).toBe(true);
    expect(isRestricted(makeEvidence({ masked: true }))).toBe(true);
    expect(isRestricted(makeEvidence())).toBe(false);
    expect(toHighlightBoxes([makeEvidence({ locked: true }), makeEvidence()])).toHaveLength(1);
  });

  it("labels highlight boxes by document", () => {
    const [box] = toHighlightBoxes([makeEvidence()]);
    expect(box.label).toBe("income_certificate.pdf");
    expect(box.bbox).toEqual([100, 200, 300, 260]);
  });

  it("finds evidence references in audit details and ignores junk", () => {
    const ev = makeEvidence();
    expect(evidenceFromDetails({ evidence: ev })).toHaveLength(1);
    expect(evidenceFromDetails({ evidence_references: [ev, { nope: true }] })).toHaveLength(1);
    expect(evidenceFromDetails({ other: 1 })).toHaveLength(0);
    expect(evidenceFromDetails(undefined)).toHaveLength(0);
  });
});

describe("computePopoverPosition", () => {
  const viewport = { width: 1000, height: 800 };
  it("goes below the anchor when there is room", () => {
    const p = computePopoverPosition({ top: 100, bottom: 120, left: 50, right: 150 }, { width: 288, height: 200 }, viewport);
    expect(p.placement).toBe("below");
    expect(p.top).toBe(128);
    expect(p.left).toBe(50);
  });
  it("flips above when it does not fit below", () => {
    const p = computePopoverPosition({ top: 700, bottom: 720, left: 50, right: 150 }, { width: 288, height: 200 }, viewport);
    expect(p.placement).toBe("above");
    expect(p.top).toBe(700 - 8 - 200);
  });
  it("stays inside the viewport horizontally", () => {
    const p = computePopoverPosition({ top: 100, bottom: 120, left: 900, right: 990 }, { width: 288, height: 100 }, viewport);
    expect(p.left).toBe(1000 - 288 - 8);
  });
});
