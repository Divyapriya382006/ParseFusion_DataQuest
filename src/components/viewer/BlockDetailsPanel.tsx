import React from "react";
import { X, AlertCircle, CheckCircle2, Scale, ShieldAlert, Cpu } from "lucide-react";
import type { Block } from "../../types/canonical";
import { ConfidenceIndicator } from "../common/ConfidenceIndicator";
import { LockedCell } from "../common/LockedCell";

interface BlockDetailsPanelProps {
  block: Block | null;
  onClose: () => void;
}

export const BlockDetailsPanel: React.FC<BlockDetailsPanelProps> = ({ block, onClose }) => {
  if (!block) return null;

  return (
    <aside className="w-80 border-l border-neutral-800 bg-neutral-900/95 flex flex-col h-full overflow-hidden shrink-0 text-xs">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-neutral-100 uppercase tracking-wider text-[11px]">
            {block.type} Block
          </span>
          <span className="font-mono text-neutral-500 text-[10px]">
            #{block.reading_order_index}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800"
          aria-label="Close details"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Locked Column / Row Policy Check */}
        {block.locked && (
          <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <div className="flex items-center gap-1.5 text-amber-400 font-medium mb-1">
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>Governed Column Restriction</span>
            </div>
            <LockedCell label="Confidential Value Withheld" />
          </div>
        )}

        {/* Confidence & Method */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-neutral-400">Extractor Confidence</span>
            <ConfidenceIndicator confidence={block.confidence} />
          </div>

          <div className="flex items-center justify-between text-neutral-400">
            <span>Extraction Method</span>
            <span className="font-mono text-neutral-200">{block.extraction_method}</span>
          </div>

          {block.confidence_breakdown && Object.keys(block.confidence_breakdown).length > 0 && (
            <div className="p-2.5 bg-neutral-950/60 rounded border border-neutral-800 space-y-1">
              <span className="text-[10px] text-neutral-500 font-semibold uppercase">Confidence Breakdown</span>
              {Object.entries(block.confidence_breakdown).map(([k, v]) => (
                <div key={k} className="flex justify-between font-mono text-[11px] text-neutral-400">
                  <span>{k}</span>
                  <span className="tabular-nums text-neutral-200">{(v * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Raw Text & Normalized Values */}
        {!block.locked && (
          <div className="space-y-2">
            <div>
              <span className="text-neutral-400 text-[11px]">Raw Text</span>
              <div className="mt-1 p-2 bg-neutral-950/80 rounded border border-neutral-800 font-mono text-[11px] text-neutral-200 break-words whitespace-pre-wrap">
                {block.raw_text || block.raw_value || "(No raw text payload)"}
              </div>
            </div>

            {block.normalized && (
              <div className="p-2.5 bg-neutral-950/40 rounded border border-neutral-800 space-y-1">
                <span className="text-[10px] text-neutral-500 font-semibold uppercase">Normalized Value</span>
                <div className="font-mono text-neutral-100 text-xs">
                  {String(block.normalized.value)}
                  {block.normalized.currency && ` (${block.normalized.currency})`}
                  {block.normalized.unit && ` ${block.normalized.unit}`}
                </div>
                <div className="text-[10px] text-neutral-500">
                  Rule applied: <span className="font-mono text-neutral-400">{block.normalized.rule}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* BBox Unavailable Reason */}
        {block.location?.bbox_unavailable_reason && (
          <div className="p-2 bg-neutral-950 rounded border border-neutral-800 text-neutral-400">
            <span className="text-neutral-500 font-medium">BBox Reason:</span>{" "}
            {block.location.bbox_unavailable_reason}
          </div>
        )}

        {/* Parser Jury (Extractor Alternatives) */}
        {block.alternatives && block.alternatives.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-neutral-300 font-medium">
              <Scale className="w-3.5 h-3.5 text-sky-400" />
              <span>Parser Jury (Candidates)</span>
            </div>
            <div className="space-y-1.5">
              {block.alternatives.map((alt, idx) => (
                <div
                  key={idx}
                  className="p-2 bg-neutral-950/70 border border-neutral-800 rounded flex flex-col gap-1"
                >
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-mono text-neutral-400 flex items-center gap-1">
                      <Cpu className="w-3 h-3 text-neutral-500" />
                      {alt.extractor}
                    </span>
                    <ConfidenceIndicator confidence={alt.confidence} size="sm" />
                  </div>
                  <div className="font-mono text-neutral-200 text-[11px] truncate">
                    {alt.value}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Validation Checks */}
        {block.validation && block.validation.length > 0 && (
          <div className="space-y-2">
            <span className="text-neutral-400 font-medium">Validation Checks</span>
            <div className="space-y-1">
              {block.validation.map((v, idx) => (
                <div
                  key={idx}
                  className="p-2 rounded border border-neutral-800/80 bg-neutral-950/40 flex items-start gap-2"
                >
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-neutral-200">{v.name}</div>
                    <div className="text-[10px] text-neutral-500 font-mono">{v.status}</div>
                    {v.detail && <div className="text-[11px] text-neutral-400 mt-0.5">{v.detail}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Warnings */}
        {block.warnings && block.warnings.length > 0 && (
          <div className="space-y-2">
            <span className="text-neutral-400 font-medium">Advisories & Warnings</span>
            <div className="space-y-1">
              {block.warnings.map((w, idx) => (
                <div
                  key={idx}
                  className="p-2 rounded border border-amber-500/20 bg-amber-500/5 text-amber-300 flex items-start gap-2"
                >
                  <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-mono text-[10px] text-amber-400">{w.code}</div>
                    <div className="text-[11px] text-neutral-300 mt-0.5">{w.message}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
