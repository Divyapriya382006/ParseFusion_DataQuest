import React from "react";
import type { Block, BoundingBox, PageUnit } from "../../types/canonical";
import { useConfig } from "../../context/ConfigContext";
import { blockToEvidence } from "../../lib/evidence";
import type { HighlightBox } from "../../lib/evidence";
import { useEvidenceHover } from "../evidence/useEvidenceHover";

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
  /** Page the blocks belong to. With it, hovering an outline shows the hover-to-source popover. */
  page?: PageUnit;
  filename?: string;
  /** Block hovered either on the page or in the side panel (two-way highlighting). */
  hoveredBlockId?: string | null;
  onHoverBlock?: (blockId: string | null) => void;
  /** Boxes published by hovered values elsewhere in the app (facts, findings, table cells ...). */
  contextBoxes?: HighlightBox[];
}

interface BlockOutlineProps {
  block: Block;
  style: { stroke: string; fill: string; strokeWidth: number };
  isHovered: boolean;
  page?: PageUnit;
  filename?: string;
  onSelectBlock: (block: Block) => void;
  onHoverBlock?: (blockId: string | null) => void;
}

const BlockOutline: React.FC<BlockOutlineProps> = ({
  block,
  style,
  isHovered,
  page,
  filename,
  onSelectBlock,
  onHoverBlock,
}) => {
  const bbox = block.location?.bbox;
  const evidence = page ? blockToEvidence(block, page, filename) : null;
  const { anchorProps, popover } = useEvidenceHover({
    evidence,
    pageData: page,
    // On the page itself, "open the source" means selecting the block in the side panel.
    onActivate: () => onSelectBlock(block),
    openOnClick: false,
    highlight: false,
  });
  if (!bbox) return null;
  const [x1, y1, x2, y2] = bbox;

  return (
    <g className="cursor-pointer">
      <rect
        x={x1}
        y={y1}
        width={Math.max(0, x2 - x1)}
        height={Math.max(0, y2 - y1)}
        stroke={isHovered ? "#22d3ee" : style.stroke}
        strokeWidth={isHovered ? style.strokeWidth + 2 : style.strokeWidth}
        fill={isHovered ? "rgba(34, 211, 238, 0.2)" : style.fill}
        data-block-id={block.block_id}
        data-hovered={isHovered ? "true" : "false"}
        tabIndex={evidence ? 0 : undefined}
        role="button"
        aria-label={`${block.type} block ${block.reading_order_index}`}
        {...(evidence ? anchorProps : {})}
        onPointerEnter={(e) => {
          onHoverBlock?.(block.block_id);
          if (evidence) anchorProps.onPointerEnter(e);
        }}
        onPointerLeave={(e) => {
          onHoverBlock?.(null);
          if (evidence) anchorProps.onPointerLeave(e);
        }}
        onFocus={() => {
          onHoverBlock?.(block.block_id);
          if (evidence) anchorProps.onFocus();
        }}
        onBlur={() => {
          onHoverBlock?.(null);
          if (evidence) anchorProps.onBlur();
        }}
        onClick={() => onSelectBlock(block)}
        className="transition-colors hover:stroke-cyan-400"
      />
      {/* Small index badge */}
      <circle cx={x1 + 8} cy={y1 + 8} r={6} fill="#0f172a" stroke={style.stroke} strokeWidth={1} />
      <text
        x={x1 + 8}
        y={y1 + 11}
        textAnchor="middle"
        fontSize={8}
        fill="#e2e8f0"
        fontFamily="monospace"
        pointerEvents="none"
      >
        {block.reading_order_index}
      </text>
      {popover}
    </g>
  );
};

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
  page,
  filename,
  hoveredBlockId,
  onHoverBlock,
  contextBoxes = [],
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
        if (!block.location?.bbox) return null;
        return (
          <BlockOutline
            key={block.block_id}
            block={block}
            style={getBlockStyle(block, selectedBlockId === block.block_id)}
            isHovered={hoveredBlockId === block.block_id}
            page={page}
            filename={filename}
            onSelectBlock={onSelectBlock}
            onHoverBlock={onHoverBlock}
          />
        );
      })}

      {/* Boxes published by hovered values elsewhere (two-way highlighting) */}
      {contextBoxes.map((box) => {
        if (!box.bbox) return null;
        const [x1, y1, x2, y2] = box.bbox;
        return (
          <rect
            key={`ctx-${box.id}`}
            data-testid="context-highlight"
            x={x1}
            y={y1}
            width={Math.max(0, x2 - x1)}
            height={Math.max(0, y2 - y1)}
            stroke="#f59e0b"
            strokeWidth={3}
            fill="rgba(245, 158, 11, 0.25)"
            pointerEvents="none"
          />
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