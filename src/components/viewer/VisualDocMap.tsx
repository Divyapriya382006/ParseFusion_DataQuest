import React from "react";
import type { PageUnit } from "../../types/canonical";

interface VisualDocMapProps {
  pages: PageUnit[];
  currentPageIndex: number;
  onSelectPage: (pageIndex: number) => void;
}

export const VisualDocMap: React.FC<VisualDocMapProps> = ({
  pages,
  currentPageIndex,
  onSelectPage,
}) => {
  return (
    <div className="flex flex-col gap-3 p-3 bg-neutral-900/60 border border-neutral-800 rounded-xl overflow-y-auto max-h-[600px] text-xs">
      <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider px-1">
        Visual Document Map ({pages.length} pages)
      </div>

      <div className="space-y-2">
        {pages.map((page, idx) => {
          const isCurrent = idx === currentPageIndex;

          return (
            <div
              key={page.page_id || idx}
              onClick={() => onSelectPage(idx)}
              className={`p-2.5 rounded-lg border transition-all cursor-pointer ${
                isCurrent
                  ? "bg-neutral-800/90 border-sky-500/80 shadow-md ring-1 ring-sky-500/30"
                  : "bg-neutral-950/60 border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900/60"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-neutral-200 text-xs">
                  Page {page.page_number}
                </span>
                <span className="text-[10px] text-neutral-500 font-mono">
                  {page.layout_class || "standard"}
                </span>
              </div>

              {/* Mini visual representation of blocks */}
              <div
                className="w-full h-16 bg-neutral-900 border border-neutral-800/80 rounded relative overflow-hidden"
                style={{
                  aspectRatio: page.width && page.height ? `${page.width} / ${page.height}` : "3 / 4",
                }}
              >
                {page.blocks?.map((block) => {
                  const bbox = block.location?.bbox;
                  if (!bbox || !page.width || !page.height) return null;
                  const [x1, y1, x2, y2] = bbox;
                  const left = `${(x1 / page.width) * 100}%`;
                  const top = `${(y1 / page.height) * 100}%`;
                  const width = `${Math.max(2, ((x2 - x1) / page.width) * 100)}%`;
                  const height = `${Math.max(2, ((y2 - y1) / page.height) * 100)}%`;

                  // Confidence color
                  const bg =
                    block.confidence >= 0.85
                      ? "bg-emerald-500/60"
                      : block.confidence >= 0.65
                      ? "bg-amber-500/60"
                      : "bg-rose-500/60";

                  return (
                    <div
                      key={block.block_id}
                      className={`absolute rounded-xs ${bg}`}
                      style={{ left, top, width, height }}
                      title={`${block.type} (${Math.round(block.confidence * 100)}%)`}
                    />
                  );
                })}
              </div>

              <div className="mt-2 flex items-center justify-between text-[10px] text-neutral-400">
                <span>{page.blocks?.length || 0} blocks</span>
                <span className="font-mono">
                  {page.reading_order_confidence
                    ? `${Math.round(page.reading_order_confidence * 100)}% order`
                    : ""}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
