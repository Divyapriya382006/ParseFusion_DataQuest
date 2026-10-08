import React, { useState, useEffect, useCallback } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Flame,
  Layers,
} from "lucide-react";
import type { PageUnit, Block } from "../../types/canonical";
import { SvgOverlay } from "./SvgOverlay";
import { BlockDetailsPanel } from "./BlockDetailsPanel";
import { useBoxesForPage } from "../../context/EvidenceHighlightContext";

interface SourceViewerProps {
  page: PageUnit;
  totalPages?: number;
  currentPageNumber: number;
  onPageChange?: (newPage: number) => void;
  highlightedBbox?: [number, number, number, number] | null;
  /** Document name shown in hover-to-source popovers (PageUnit does not carry it). */
  filename?: string;
  onClose?: () => void;
}

export const SourceViewer: React.FC<SourceViewerProps> = ({
  page,
  totalPages = 1,
  currentPageNumber,
  onPageChange,
  highlightedBbox,
  filename,
}) => {
  const [zoom, setZoom] = useState(1);
  const [selectedBlock, setSelectedBlock] = useState<Block | null>(null);
  // Two-way highlighting: the block hovered on the page or in the side panel.
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  // Boxes of values hovered elsewhere in the app that point at this very page.
  const contextBoxes = useBoxesForPage(page.source_id, page.page_number);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showUncovered, setShowUncovered] = useState(false);

  const handleZoomIn = () => setZoom((z) => Math.min(3, z + 0.25));
  const handleZoomOut = () => setZoom((z) => Math.max(0.5, z - 0.25));
  const handleZoomReset = () => setZoom(1);

  const handlePrevPage = useCallback(() => {
    if (currentPageNumber > 1 && onPageChange) {
      onPageChange(currentPageNumber - 1);
    }
  }, [currentPageNumber, onPageChange]);

  const handleNextPage = useCallback(() => {
    if (currentPageNumber < totalPages && onPageChange) {
      onPageChange(currentPageNumber + 1);
    }
  }, [currentPageNumber, totalPages, onPageChange]);

  // Keyboard navigation shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === "ArrowLeft") handlePrevPage();
      if (e.key === "ArrowRight") handleNextPage();
      if (e.key === "+" || e.key === "=") handleZoomIn();
      if (e.key === "-") handleZoomOut();
      if (e.key === "0") handleZoomReset();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handlePrevPage, handleNextPage]);

  return (
    <div className="flex h-full w-full bg-neutral-950 border border-neutral-800 rounded-xl overflow-hidden">
      {/* Main Canvas Viewport */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Controls Toolbar */}
        <div className="h-12 border-b border-neutral-800 bg-neutral-900/80 px-4 flex items-center justify-between gap-4 shrink-0 text-xs">
          {/* Pagination */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handlePrevPage}
              disabled={currentPageNumber <= 1}
              className="p-1.5 rounded hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent text-neutral-300"
              title="Previous Page (Left Arrow)"
              aria-label="Previous Page"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="font-mono text-neutral-300 px-2 tabular-nums">
              Page {currentPageNumber} / {totalPages}
            </span>
            <button
              type="button"
              onClick={handleNextPage}
              disabled={currentPageNumber >= totalPages}
              className="p-1.5 rounded hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent text-neutral-300"
              title="Next Page (Right Arrow)"
              aria-label="Next Page"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Layer Toggles & Heatmap */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowHeatmap((h) => !h)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded border transition-colors ${
                showHeatmap
                  ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                  : "bg-neutral-800/60 border-neutral-700/60 text-neutral-400 hover:text-neutral-200"
              }`}
              title="Toggle Confidence Heatmap"
            >
              <Flame className="w-3.5 h-3.5" />
              <span>Heatmap</span>
            </button>

            <button
              type="button"
              onClick={() => setShowUncovered((u) => !u)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded border transition-colors ${
                showUncovered
                  ? "bg-rose-500/20 border-rose-500/40 text-rose-300"
                  : "bg-neutral-800/60 border-neutral-700/60 text-neutral-400 hover:text-neutral-200"
              }`}
              title="Toggle Uncovered Regions"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Uncovered Regions</span>
            </button>
          </div>

          {/* Zoom controls */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleZoomOut}
              className="p-1.5 rounded hover:bg-neutral-800 text-neutral-300"
              title="Zoom Out (-)"
              aria-label="Zoom Out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="font-mono text-neutral-400 px-1 text-[11px] tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={handleZoomIn}
              className="p-1.5 rounded hover:bg-neutral-800 text-neutral-300"
              title="Zoom In (+)"
              aria-label="Zoom In"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleZoomReset}
              className="p-1.5 rounded hover:bg-neutral-800 text-neutral-300 ml-1"
              title="Reset Zoom (0)"
              aria-label="Reset Zoom"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Viewport Workspace */}
        <div className="flex-1 overflow-auto p-6 flex items-center justify-center bg-neutral-950/80">
          <div
            className="relative shadow-2xl transition-transform duration-100 ease-out origin-center"
            style={{
              width: `${page.width * zoom}px`,
              height: `${page.height * zoom}px`,
              maxWidth: "none",
            }}
          >
            {/* Page Canvas Image */}
            <img
              src={page.image_url}
              alt={`Page ${page.page_number}`}
              referrerPolicy="no-referrer"
              className="w-full h-full object-contain pointer-events-none select-none bg-neutral-900 rounded"
              loading="lazy"
            />

            {/* SVG Interactive Overlay */}
            <SvgOverlay
              pageWidth={page.width}
              pageHeight={page.height}
              blocks={page.blocks || []}
              selectedBlockId={selectedBlock?.block_id}
              highlightedBbox={highlightedBbox}
              onSelectBlock={(b) => setSelectedBlock(b)}
              showHeatmap={showHeatmap}
              showUncovered={showUncovered}
              uncoveredRegions={page.uncovered_regions || []}
              page={page}
              filename={filename}
              hoveredBlockId={hoveredBlockId}
              onHoverBlock={setHoveredBlockId}
              contextBoxes={contextBoxes}
            />
          </div>
        </div>
      </div>

      {/* Side Details Panel */}
      {selectedBlock && (
        <BlockDetailsPanel
          block={selectedBlock}
          onClose={() => setSelectedBlock(null)}
          page={page}
          filename={filename}
          hoveredBlockId={hoveredBlockId}
          onHoverValue={setHoveredBlockId}
        />
      )}
    </div>
  );
};