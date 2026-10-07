import React, { useState } from "react";
import { Layers, Bookmark, ArrowRight, Filter } from "lucide-react";
import type { VirtualPageMapping } from "../../agents/13_virtualMerge";
import type { ID } from "../../types/canonical";

interface VirtualDocViewerProps {
  virtualDocumentId: ID;
  pages: VirtualPageMapping[];
  onSelectVirtualPage?: (mapping: VirtualPageMapping) => void;
}

export const VirtualDocViewer: React.FC<VirtualDocViewerProps> = ({
  virtualDocumentId,
  pages,
  onSelectVirtualPage,
}) => {
  const [selectedSourceFilter, setSelectedSourceFilter] = useState<string>("ALL");

  // Unique sources in sequence
  const uniqueSources = Array.from(new Set(pages.map((p) => p.source_id)));

  const filteredPages =
    selectedSourceFilter === "ALL"
      ? pages
      : pages.filter((p) => p.source_id === selectedSourceFilter);

  return (
    <div className="space-y-4 text-xs">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-sky-400" />
          <span className="font-semibold text-neutral-100">Virtual Sequence:</span>
          <span className="font-mono text-neutral-400">{virtualDocumentId}</span>
          <span className="text-neutral-500">({pages.length} global pages)</span>
        </div>

        {/* Source Filter */}
        <div className="flex items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-neutral-500" />
          <span className="text-neutral-400 text-xs">Filter by Source:</span>
          <select
            value={selectedSourceFilter}
            onChange={(e) => setSelectedSourceFilter(e.target.value)}
            className="bg-neutral-950 border border-neutral-800 rounded px-2.5 py-1 text-neutral-200 text-xs"
          >
            <option value="ALL">All Documents ({uniqueSources.length})</option>
            {uniqueSources.map((srcId) => (
              <option key={srcId} value={srcId}>
                {srcId}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Virtual Page Sequence Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filteredPages.map((item) => (
          <div
            key={`${item.source_id}-${item.page_number}`}
            onClick={() => onSelectVirtualPage?.(item)}
            className={`p-3 rounded-xl border transition-all cursor-pointer ${
              item.boundary_start
                ? "bg-neutral-900/90 border-sky-500/50 hover:border-sky-400 ring-1 ring-sky-500/20"
                : "bg-neutral-950/60 border-neutral-800 hover:border-neutral-700"
            }`}
          >
            {item.boundary_start && (
              <div className="flex items-center gap-1.5 text-sky-400 text-[10px] font-semibold uppercase tracking-wider mb-2">
                <Bookmark className="w-3 h-3" />
                <span>Source Boundary Start</span>
              </div>
            )}

            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-sm font-semibold text-neutral-100 tabular-nums">
                Page #{item.virtual_page_number}
              </span>
              <span className="font-mono text-[11px] text-neutral-400">
                {item.page_id}
              </span>
            </div>

            <div className="p-2 bg-neutral-950/80 rounded border border-neutral-800/80 flex items-center justify-between text-[11px] font-mono">
              <div className="truncate text-neutral-400 max-w-[150px]">
                {item.source_id}
              </div>
              <div className="flex items-center gap-1 text-neutral-300">
                <ArrowRight className="w-3 h-3 text-neutral-600" />
                <span>Page {item.page_number}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
