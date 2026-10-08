import React from "react";
import { Link2, ShieldAlert } from "lucide-react";
import type { EvidenceReference, PageUnit, TableBlock, TableCell } from "../../types/canonical";
import { LockedCell } from "../common/LockedCell";
import { useEvidence } from "../../context/EvidenceContext";
import { useBoxesForPage } from "../../context/EvidenceHighlightContext";
import { EvidenceHover } from "../evidence/EvidenceHover";
import { PageHighlightView } from "../evidence/PageHighlightView";
import { isValidBbox } from "../../lib/evidence";

interface TableRendererProps {
  table: TableBlock;
  onCellClick?: (cell: TableCell) => void;
  onRequestAccess?: (columnName?: string) => void;
  /** Page the table sits on. Gives cells their page number and enables the linked page preview. */
  page?: PageUnit;
  filename?: string;
}

export const TableRenderer: React.FC<TableRendererProps> = ({
  table,
  onCellClick,
  onRequestAccess,
  page,
  filename,
}) => {
  const { openEvidence } = useEvidence();
  const pageBoxes = useBoxesForPage(table.source_id, page?.page_number);

  const cellEvidence = (cell: TableCell): EvidenceReference | null => {
    if (!page) return null;
    const restricted = Boolean(cell.locked || table.locked);
    return {
      source_id: table.source_id,
      filename: filename ?? "",
      page_number: page.page_number,
      page_id: page.page_id,
      block_id: table.block_id,
      text_excerpt: restricted ? "" : cell.raw_text,
      bbox: isValidBbox(cell.location?.bbox) ? cell.location.bbox : null,
      confidence: cell.confidence,
      extraction_method: table.extraction_method,
      bbox_unavailable_reason: cell.location?.bbox_unavailable_reason,
      page_width: page.width,
      page_height: page.height,
      locked: restricted,
    };
  };

  // Compute table grid from cells or n_rows / n_cols
  const rows: TableCell[][] = [];
  for (let r = 0; r < table.n_rows; r++) {
    rows[r] = [];
  }

  table.cells.forEach((cell) => {
    if (cell.row < table.n_rows) {
      rows[cell.row][cell.col] = cell;
    }
  });

  const handleCellClick = (cell: TableCell) => {
    if (onCellClick) {
      onCellClick(cell);
    } else if (cell.location?.bbox) {
      openEvidence(
        cellEvidence(cell) ?? {
          source_id: table.source_id,
          filename: filename ?? "",
          page_number: page?.page_number ?? 1,
          block_id: table.block_id,
          text_excerpt: cell.raw_text,
          bbox: cell.location.bbox,
          confidence: cell.confidence,
        }
      );
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl text-xs overflow-hidden">
      {/* Table Header: Caption, Badges, Continuations */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-neutral-800">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-neutral-100 text-sm">
              {table.caption || `Table ${table.table_id}`}
            </span>
            <span className="font-mono text-[11px] text-neutral-500">
              ({table.n_rows} rows × {table.n_cols} cols)
            </span>
          </div>

          {/* Continuation links */}
          {(table.continues_from || table.continues_to) && (
            <div className="flex items-center gap-3 mt-1 text-[11px] font-mono text-sky-400">
              {table.continues_from && (
                <span className="flex items-center gap-1">
                  <Link2 className="w-3 h-3" /> Continues from: {table.continues_from}
                </span>
              )}
              {table.continues_to && (
                <span className="flex items-center gap-1">
                  <Link2 className="w-3 h-3" /> Continues to: {table.continues_to}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Badges exactly as returned by backend */}
        {table.badges && table.badges.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {table.badges.map((b, idx) => (
              <div
                key={idx}
                className="px-2.5 py-1 rounded border border-neutral-700 bg-neutral-800/80 text-neutral-300 text-[11px] font-medium flex items-center gap-1"
                title={b.detail}
              >
                <span>{b.label}</span>
                <span className="text-neutral-500 font-mono text-[10px]">({b.status})</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Whole Table Locked Warning */}
      {table.locked && (
        <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-center justify-between">
          <div className="flex items-center gap-2 text-amber-300">
            <ShieldAlert className="w-4 h-4" />
            <span>This entire table is restricted by governed access control.</span>
          </div>
          {onRequestAccess && (
            <button
              type="button"
              onClick={() => onRequestAccess()}
              className="text-amber-400 underline hover:text-amber-300"
            >
              Request Access
            </button>
          )}
        </div>
      )}

      {/* Table Grid */}
      <div className="w-full overflow-x-auto">
        <table className="w-full border-collapse border border-neutral-800 text-left">
          <tbody>
            {rows.map((rowCells, rIdx) => (
              <tr key={rIdx} className="border-b border-neutral-800/60 hover:bg-neutral-800/20">
                {rowCells.map((cell, cIdx) => {
                  if (!cell) {
                    return (
                      <td
                        key={cIdx}
                        className="border border-neutral-800/60 p-2 text-neutral-600 font-mono"
                      >
                        —
                      </td>
                    );
                  }

                  const isHeader = cell.is_header || rIdx === 0;

                  // Confidence color tint
                  const confidenceTint =
                    cell.confidence >= 0.85
                      ? "hover:bg-emerald-500/10"
                      : cell.confidence >= 0.65
                      ? "hover:bg-amber-500/10"
                      : "hover:bg-rose-500/10";

                  if (cell.locked) {
                    return (
                      <td
                        key={cIdx}
                        rowSpan={cell.row_span || 1}
                        colSpan={cell.col_span || 1}
                        className="border border-neutral-800/60 p-1.5"
                      >
                        <EvidenceHover evidence={cellEvidence(cell)} as="div" openOnClick={false} focusable>
                          <LockedCell
                            compact
                            label="Restricted"
                            onRequestAccess={onRequestAccess ? () => onRequestAccess() : undefined}
                          />
                        </EvidenceHover>
                      </td>
                    );
                  }

                  return (
                    <td
                      key={cIdx}
                      rowSpan={cell.row_span || 1}
                      colSpan={cell.col_span || 1}
                      onClick={() => handleCellClick(cell)}
                      className={`border border-neutral-800/60 p-2 cursor-pointer transition-colors ${confidenceTint} ${
                        isHeader
                          ? "bg-neutral-800/60 font-semibold text-neutral-200"
                          : "text-neutral-300 font-mono tabular-nums"
                      }`}
                      title={`Confidence: ${Math.round(cell.confidence * 100)}% (Click to inspect source anchor)`}
                    >
                      <EvidenceHover
                        evidence={cellEvidence(cell)}
                        as="div"
                        openOnClick={false}
                        onActivate={() => handleCellClick(cell)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">{cell.raw_text}</span>
                          {cell.confidence < 0.7 && (
                            <span
                              className="w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0"
                              title="Manual review recommended"
                            />
                          )}
                        </div>
                      </EvidenceHover>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Linked page preview: the hovered cell's box is drawn on the page it was read from */}
      {page && !table.locked && (
        <details open className="max-w-sm" data-testid="table-page-preview">
          <summary className="cursor-pointer text-[11px] text-neutral-400 mb-1.5">
            Source page {page.page_number}
          </summary>
          <PageHighlightView
            imageUrl={page.image_url}
            pageWidth={page.width}
            pageHeight={page.height}
            outline={isValidBbox(table.location?.bbox) ? table.location.bbox : null}
            boxes={pageBoxes}
          />
        </details>
      )}
    </div>
  );
};