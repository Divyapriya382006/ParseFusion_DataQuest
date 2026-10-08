import type { Block, EvidenceReference, PageUnit } from "../types/canonical";
import { EvidenceReferenceSchema } from "../types/schemas";

/**
 * Pure helpers for hover-to-source. Nothing here talks to the backend and nothing here invents content:
 * every value comes from an EvidenceReference or from page data the backend returned.
 */

export type Bbox = [number, number, number, number];

/** A box to draw on a page image. Used for two-way highlighting and the case-review preview. */
export interface HighlightBox {
  id: string;
  source_id: string;
  page_number: number;
  bbox: Bbox | null;
  /** Label drawn next to the box (the document name). */
  label?: string;
  bbox_unavailable_reason?: string;
}

export function isRestricted(ev: Pick<EvidenceReference, "locked" | "masked"> | null | undefined): boolean {
  return Boolean(ev && (ev.locked || ev.masked));
}

export function isValidBbox(bbox: unknown): bbox is Bbox {
  return (
    Array.isArray(bbox) &&
    bbox.length === 4 &&
    bbox.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    (bbox as number[])[2] > (bbox as number[])[0] &&
    (bbox as number[])[3] > (bbox as number[])[1]
  );
}

/** Stable identity of a piece of evidence. */
export function evidenceKey(ev: EvidenceReference): string {
  const box = ev.bbox ? ev.bbox.join(",") : "none";
  return `${ev.source_id}|${ev.page_number}|${ev.block_id}|${box}`;
}

export function toHighlightBox(ev: EvidenceReference): HighlightBox {
  return {
    id: evidenceKey(ev),
    source_id: ev.source_id,
    page_number: ev.page_number,
    bbox: isValidBbox(ev.bbox) ? ev.bbox : null,
    label: ev.filename || ev.source_id,
    bbox_unavailable_reason: ev.bbox_unavailable_reason,
  };
}

/** Restricted evidence never produces a box. */
export function toHighlightBoxes(evidences: readonly EvidenceReference[] | null | undefined): HighlightBox[] {
  return (evidences ?? []).filter((ev) => !isRestricted(ev)).map(toHighlightBox);
}

/** Builds the evidence reference of a block of a loaded page. Only backend values are used. */
export function blockToEvidence(block: Block, page: PageUnit, filename?: string): EvidenceReference {
  return {
    source_id: block.source_id || page.source_id,
    filename: filename ?? "",
    page_number: page.page_number,
    page_id: page.page_id,
    block_id: block.block_id,
    text_excerpt: block.locked || block.masked ? "" : block.raw_text ?? block.raw_value ?? "",
    bbox: isValidBbox(block.location?.bbox) ? block.location.bbox : null,
    confidence: block.confidence,
    extraction_method: block.extraction_method,
    bbox_unavailable_reason: block.location?.bbox_unavailable_reason,
    page_width: page.width,
    page_height: page.height,
    locked: block.locked,
    masked: block.masked,
  };
}

/**
 * Finds evidence references inside an audit event's details (entries that reference a block).
 * Accepts `evidence`, `evidence_reference`, `evidence_references` as an object or an array. Anything that does not
 * validate against the EvidenceReference schema is ignored.
 */
export function evidenceFromDetails(details: Record<string, unknown> | null | undefined): EvidenceReference[] {
  if (!details) return [];
  const out: EvidenceReference[] = [];
  for (const key of ["evidence", "evidence_reference", "evidence_references"]) {
    const raw = details[key];
    const candidates = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const c of candidates) {
      const parsed = EvidenceReferenceSchema.safeParse(c);
      if (parsed.success) out.push(parsed.data as EvidenceReference);
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------------- thumbnails

export interface ThumbnailGeometry {
  /** Size of the visible thumbnail box in CSS px. */
  width: number;
  height: number;
  /** CSS background-size / background-position that show the region of the page image. */
  backgroundWidth: number;
  backgroundHeight: number;
  backgroundX: number;
  backgroundY: number;
  /** The evidence box inside the thumbnail, or null when there is nothing to highlight. */
  highlight: { left: number; top: number; width: number; height: number } | null;
}

export interface ThumbnailOptions {
  maxWidth?: number;
  maxHeight?: number;
  /** Context drawn around the box, as a fraction of the box size (min `minPad` px of the page). */
  padFraction?: number;
  minPad?: number;
}

const DEFAULTS = { maxWidth: 256, maxHeight: 144, padFraction: 0.25, minPad: 12 };

/**
 * Crop geometry for a region of a page, scaled from the page's reported width/height.
 * `bbox === null` returns the whole page with no highlight.
 */
export function computeThumbnail(
  bbox: Bbox | null,
  pageWidth: number,
  pageHeight: number,
  options: ThumbnailOptions = {}
): ThumbnailGeometry | null {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return null;
  const { maxWidth, maxHeight, padFraction, minPad } = { ...DEFAULTS, ...options };

  let rx = 0;
  let ry = 0;
  let rw = pageWidth;
  let rh = pageHeight;
  let box: Bbox | null = null;

  if (isValidBbox(bbox)) {
    const x1 = Math.max(0, Math.min(bbox[0], pageWidth));
    const y1 = Math.max(0, Math.min(bbox[1], pageHeight));
    const x2 = Math.max(0, Math.min(bbox[2], pageWidth));
    const y2 = Math.max(0, Math.min(bbox[3], pageHeight));
    if (x2 > x1 && y2 > y1) {
      box = [x1, y1, x2, y2];
      const padX = Math.max(minPad, (x2 - x1) * padFraction);
      const padY = Math.max(minPad, (y2 - y1) * padFraction);
      rx = Math.max(0, x1 - padX);
      ry = Math.max(0, y1 - padY);
      rw = Math.min(pageWidth, x2 + padX) - rx;
      rh = Math.min(pageHeight, y2 + padY) - ry;
    }
  }

  const scale = Math.min(maxWidth / rw, maxHeight / rh);
  return {
    width: rw * scale,
    height: rh * scale,
    backgroundWidth: pageWidth * scale,
    backgroundHeight: pageHeight * scale,
    backgroundX: 0 - rx * scale,
    backgroundY: 0 - ry * scale,
    highlight: box
      ? {
          left: (box[0] - rx) * scale,
          top: (box[1] - ry) * scale,
          width: (box[2] - box[0]) * scale,
          height: (box[3] - box[1]) * scale,
        }
      : null,
  };
}

// Thumbnail geometry cache, keyed by (page_id, bbox, page size). The geometry is pure, so caching only saves work.
const thumbnailCache = new Map<string, ThumbnailGeometry | null>();

export function thumbnailCacheKey(pageKey: string, bbox: Bbox | null, pageWidth: number, pageHeight: number): string {
  return `${pageKey}|${bbox ? bbox.join(",") : "none"}|${pageWidth}x${pageHeight}`;
}

export function getCachedThumbnail(
  pageKey: string,
  bbox: Bbox | null,
  pageWidth: number,
  pageHeight: number,
  options?: ThumbnailOptions
): ThumbnailGeometry | null {
  const key = `${thumbnailCacheKey(pageKey, bbox, pageWidth, pageHeight)}|${JSON.stringify(options ?? {})}`;
  if (thumbnailCache.has(key)) return thumbnailCache.get(key) ?? null;
  const geometry = computeThumbnail(bbox, pageWidth, pageHeight, options);
  thumbnailCache.set(key, geometry);
  return geometry;
}

export function clearThumbnailCache(): void {
  thumbnailCache.clear();
}

// ---------------------------------------------------------------------------------------------- page images

type ImageState = "loading" | "loaded" | "error";
const imageState = new Map<string, ImageState>();
const imagePromises = new Map<string, Promise<void>>();

export function isImageLoaded(src: string): boolean {
  return imageState.get(src) === "loaded";
}

/**
 * Loads a page image once. Images that are already loaded (or loading) are never requested again, so hovering the
 * same page repeatedly costs nothing. Called only when a popover opens, which is what makes loading lazy.
 */
export function preloadImage(src: string): Promise<void> {
  const existing = imagePromises.get(src);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    imageState.set(src, "loading");
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      imageState.set(src, "loaded");
      resolve();
    };
    img.onerror = () => {
      imageState.set(src, "error");
      imagePromises.delete(src);
      reject(new Error("image failed to load"));
    };
    img.src = src;
  });
  imagePromises.set(src, promise);
  return promise;
}

export function resetImageCache(): void {
  imageState.clear();
  imagePromises.clear();
}

// ----------------------------------------------------------------------------------------------- positioning

export interface PopoverPosition {
  top: number;
  left: number;
  placement: "below" | "above";
}

/** Anchors a floating popover under (or above, if there is no room) the value, kept inside the viewport. */
export function computePopoverPosition(
  anchor: { top: number; bottom: number; left: number; right: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
  margin = 8
): PopoverPosition {
  const spaceBelow = viewport.height - anchor.bottom - gap - margin;
  const spaceAbove = anchor.top - gap - margin;
  const placement: "below" | "above" = size.height <= spaceBelow || spaceBelow >= spaceAbove ? "below" : "above";
  let top = placement === "below" ? anchor.bottom + gap : anchor.top - gap - size.height;
  top = Math.max(margin, Math.min(top, viewport.height - size.height - margin));
  let left = anchor.left;
  left = Math.max(margin, Math.min(left, viewport.width - size.width - margin));
  return { top, left, placement };
}
