import React from "react";
import type { HighlightBox } from "../../lib/evidence";
import { isValidBbox } from "../../lib/evidence";

interface PageHighlightViewProps {
  imageUrl: string;
  /** Page size as reported by the backend; box coordinates are in these pixels. */
  pageWidth: number;
  pageHeight: number;
  boxes: readonly HighlightBox[];
  /** Quiet outline drawn under the highlight boxes, e.g. the whole table. */
  outline?: [number, number, number, number] | null;
  className?: string;
  alt?: string;
}

/**
 * A page image with highlight boxes drawn over it in an SVG scaled from page_width/page_height.
 * Used by the table page preview and the case-review evidence preview.
 */
export const PageHighlightView: React.FC<PageHighlightViewProps> = ({
  imageUrl,
  pageWidth,
  pageHeight,
  boxes,
  outline,
  className,
  alt = "Source page",
}) => {
  const fontSize = Math.max(12, pageWidth * 0.02);
  return (
    <div
      data-testid="page-highlight-view"
      className={`relative w-full overflow-hidden rounded border border-neutral-800 bg-neutral-900 ${className ?? ""}`}
      style={{ aspectRatio: `${pageWidth} / ${pageHeight}` }}
    >
      <img
        src={imageUrl}
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="absolute inset-0 h-full w-full object-contain select-none pointer-events-none"
      />
      <svg viewBox={`0 0 ${pageWidth} ${pageHeight}`} className="absolute inset-0 h-full w-full pointer-events-none">
        {outline && isValidBbox(outline) && (
          <rect
            x={outline[0]}
            y={outline[1]}
            width={outline[2] - outline[0]}
            height={outline[3] - outline[1]}
            fill="none"
            stroke="#64748b"
            strokeWidth={Math.max(1, pageWidth * 0.002)}
            strokeDasharray="6 4"
          />
        )}
        {boxes.map((box) => {
          if (!isValidBbox(box.bbox)) return null;
          const [x1, y1, x2, y2] = box.bbox;
          const labelHeight = fontSize * 1.5;
          const labelY = y1 - labelHeight >= 0 ? y1 - labelHeight : y2;
          const label = box.label ?? "";
          const labelWidth = Math.min(pageWidth - x1, Math.max(fontSize * 3, label.length * fontSize * 0.6 + fontSize));
          return (
            <g key={box.id} data-testid="highlight-box" data-source-id={box.source_id}>
              <rect
                x={x1}
                y={y1}
                width={x2 - x1}
                height={y2 - y1}
                fill="rgba(245, 158, 11, 0.25)"
                stroke="#f59e0b"
                strokeWidth={Math.max(2, pageWidth * 0.003)}
              />
              {label && (
                <>
                  <rect x={x1} y={labelY} width={labelWidth} height={labelHeight} fill="#f59e0b" />
                  <text
                    x={x1 + fontSize * 0.4}
                    y={labelY + labelHeight * 0.72}
                    fontSize={fontSize}
                    fill="#0f172a"
                    fontFamily="monospace"
                  >
                    {label}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
};
