import React from "react";
import type { Block, BoundingBox } from "../../types/canonical";
import { useConfig } from "../../context/ConfigContext";

interface SvgOverlayProps {
  pageWidth: number;
  pageHeight: number;
  blocks: Block[];
  selectedBlockId?: string | null;
  highlightedBbox?: [number, number, number, number] | null;
  onSelectBlock: (block: Block) => void;
  showHeatmap: boolean;
  showUncovered: boolean;
  uncoveredRegions?: BoundingBox[];
}

export const SvgOverlay: React.FC<SvgOverlayProps> = ({
  pageWidth,
  pageHeight,
  blocks,
  selectedBlockId,
  highlightedBbox,
  onSelectBlock,
  showHeatmap,
  showUncovered,
  uncoveredRegions = [],
}) => {
  const { config } = useConfig();

  // Helper to resolve stroke/fill for heatmap or block types
  const getBlockStyle = (block: Block, isSelected: boolean) => {
    if (isSelected) {
      return {
        stroke: "#38bdf8", // Sky blue
        fill: "rgba(56, 189, 248, 0.2)",
        strokeWidth: 3,
      };
    }

    if (showHeatmap) {
      const conf = block.confidence ?? 0;
      // Match against backend config.confidence_bands
      const band = config?.confidence_bands?.find(
        (b) => conf >= b.min && conf <= b.max
      );
      if (band?.id === "high" || conf >= 0.85) {
        return {
          stroke: "#22c55e",
          fill: "rgba(34, 197, 94, 0.15)",
          strokeWidth: 1.5,
        };
      }
      if (band?.id === "medium" || conf >= 0.65) {
        return {
          stroke: "#f59e0b",
          fill: "rgba(245, 158, 11, 0.15)",
          strokeWidth: 1.5,
        };
      }
      return {
        stroke: "#ef4444",
        fill: "rgba(239, 68, 68, 0.2)",
        strokeWidth: 2,
      };
    }

    // Default neutral outline based on block type
    switch (block.type) {
      case "table":
        return {
          stroke: "#818cf8", // Indigo
          fill: "rgba(129, 140, 248, 0.1)",
          strokeWidth: 1.5,
        };
      case "chart":
      case "figure":
        return {
          stroke: "#f472b6", // Pink
          fill: "rgba(244, 114, 182, 0.1)",
          strokeWidth: 1.5,
        };
      case "equation":
        return {
          stroke: "#a78bfa", // Purple
          fill: "rgba(167, 139, 250, 0.1)",
          strokeWidth: 1.5,
        };
      default:
        return {
          stroke: "#64748b", // Slate
          fill: "rgba(100, 116, 139, 0.08)",
          strokeWidth: 1,
        };
    }
  };

  return (
    <svg
      viewBox={`0 0 ${pageWidth} ${pageHeight}`}
      className="absolute inset-0 w-full h-full pointer-events-auto"
      style={{ overflow: "visible" }}
    >
      {/* Uncovered regions from consensus coverage */}
      {showUncovered &&
        uncoveredRegions.map((region, idx) => {
          if (!region.bbox) return null;
          const [x1, y1, x2, y2] = region.bbox;
          return (
            <rect
              key={`uncovered-${idx}`}
              x={x1}
              y={y1}
              width={Math.max(0, x2 - x1)}
              height={Math.max(0, y2 - y1)}
              stroke="#fb7185"
              strokeDasharray="4 4"
              strokeWidth={2}
              fill="rgba(251, 113, 133, 0.15)"
            >
              <title>Uncovered region (Potential missing extraction)</title>
            </rect>
          );
        })}

      {/* Structured Blocks */}
      {blocks.map((block) => {
        const bbox = block.location?.bbox;
        if (!bbox) return null;
        const [x1, y1, x2, y2] = bbox;
        const isSelected = selectedBlockId === block.block_id;
        const style = getBlockStyle(block, isSelected);

        return (
          <g key={block.block_id} className="cursor-pointer">
            <rect
              x={x1}
              y={y1}
              width={Math.max(0, x2 - x1)}
              height={Math.max(0, y2 - y1)}
              stroke={style.stroke}
              strokeWidth={style.strokeWidth}
              fill={style.fill}
              onClick={() => onSelectBlock(block)}
              className="transition-colors hover:stroke-cyan-400"
            />
            {/* Small index badge */}
            <circle
              cx={x1 + 8}
              cy={y1 + 8}
              r={6}
              fill="#0f172a"
              stroke={style.stroke}
              strokeWidth={1}
            />
            <text
              x={x1 + 8}
              y={y1 + 11}
              textAnchor="middle"
              fontSize={8}
              fill="#e2e8f0"
              fontFamily="monospace"
            >
              {block.reading_order_index}
            </text>
          </g>
        );
      })}

      {/* External Highlighted Bounding Box (Click-to-source evidence anchor) */}
      {highlightedBbox && (
        <rect
          x={highlightedBbox[0]}
          y={highlightedBbox[1]}
          width={Math.max(0, highlightedBbox[2] - highlightedBbox[0])}
          height={Math.max(0, highlightedBbox[3] - highlightedBbox[1])}
          stroke="#f59e0b"
          strokeWidth={4}
          fill="rgba(245, 158, 11, 0.25)"
          strokeDasharray="6 3"
          className="animate-pulse"
        >
          <title>Evidence Anchor Location</title>
        </rect>
      )}
    </svg>
  );
};
