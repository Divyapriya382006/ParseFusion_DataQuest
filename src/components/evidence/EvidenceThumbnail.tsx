import React from "react";
import { getCachedThumbnail } from "../../lib/evidence";
import type { Bbox } from "../../lib/evidence";
import { useImageReady } from "./useImageReady";

interface EvidenceThumbnailProps {
  /** Page image from the backend (page.image_url). */
  imageUrl: string;
  /** Page identity used to cache the geometry per (page, bbox). */
  pageKey: string;
  /** Page size as reported by the backend; the bbox is in these pixels. */
  pageWidth: number;
  pageHeight: number;
  /** null shows the whole page with no highlight box. */
  bbox: Bbox | null;
  maxWidth?: number;
  maxHeight?: number;
  /** Image loading only starts when true (a popover opens). */
  active?: boolean;
}

/**
 * Client-side crop of the page image. Uses CSS background-position, so no extra image is requested from the backend
 * and the browser reuses the page image it already has.
 */
export const EvidenceThumbnail: React.FC<EvidenceThumbnailProps> = ({
  imageUrl,
  pageKey,
  pageWidth,
  pageHeight,
  bbox,
  maxWidth = 256,
  maxHeight = 144,
  active = true,
}) => {
  const readiness = useImageReady(imageUrl, active);
  const geometry = getCachedThumbnail(pageKey, bbox, pageWidth, pageHeight, { maxWidth, maxHeight });

  if (!geometry) {
    return (
      <div data-testid="evidence-thumbnail-unavailable" className="text-[11px] text-neutral-500">
        Preview unavailable
      </div>
    );
  }

  return (
    <div
      data-testid="evidence-thumbnail"
      data-state={readiness}
      data-has-highlight={geometry.highlight ? "true" : "false"}
      role="img"
      aria-label={bbox ? "Cropped source region" : "Source page"}
      className="relative overflow-hidden rounded border border-neutral-700 bg-neutral-900"
      style={{
        width: geometry.width,
        height: geometry.height,
        backgroundImage: readiness === "ready" ? `url("${imageUrl}")` : undefined,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${geometry.backgroundWidth}px ${geometry.backgroundHeight}px`,
        backgroundPosition: `${geometry.backgroundX}px ${geometry.backgroundY}px`,
      }}
    >
      {readiness !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-neutral-500">
          {readiness === "error" ? "Preview unavailable" : "Loading preview…"}
        </div>
      )}
      {geometry.highlight && (
        <div
          data-testid="evidence-thumbnail-box"
          className="absolute border-2 border-amber-400 bg-amber-400/20 pointer-events-none"
          style={{
            left: geometry.highlight.left,
            top: geometry.highlight.top,
            width: geometry.highlight.width,
            height: geometry.highlight.height,
          }}
        />
      )}
    </div>
  );
};
