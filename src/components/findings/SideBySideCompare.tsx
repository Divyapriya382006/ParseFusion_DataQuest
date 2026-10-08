import React from "react";
import { ArrowLeftRight, Eye } from "lucide-react";
import type { EvidenceReference } from "../../types/canonical";
import { useEvidence } from "../../context/EvidenceContext";
import { EvidenceHover } from "../evidence/EvidenceHover";

interface SideBySideCompareProps {
  primary: EvidenceReference;
  secondary: EvidenceReference;
}

export const SideBySideCompare: React.FC<SideBySideCompareProps> = ({
  primary,
  secondary,
}) => {
  const { openEvidence } = useEvidence();

  return (
    <div className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-3 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold text-neutral-200">
          <ArrowLeftRight className="w-4 h-4 text-sky-400" />
          <span>Cross-Document Evidence Comparison</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Document A Evidence */}
        <div className="p-3 bg-neutral-950/70 border border-neutral-800 rounded-lg flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-neutral-400 text-[11px] mb-1">
              <span className="font-semibold text-neutral-200">Source A</span>
              <span className="font-mono">Page {primary.page_number}</span>
            </div>
            <div className="font-mono text-neutral-300 text-[11px] truncate mb-2">
              {primary.filename || primary.source_id}
            </div>
            <EvidenceHover
              evidence={primary}
              as="div"
              className="p-2.5 bg-neutral-900 rounded border border-neutral-800/80 font-mono text-neutral-100 text-xs"
            >
              "{primary.text_excerpt}"
            </EvidenceHover>
          </div>
          <div className="mt-3 pt-2 border-t border-neutral-800/60 flex items-center justify-between">
            <span className="text-neutral-500 font-mono text-[11px]">
              Conf: {Math.round(primary.confidence * 100)}%
            </span>
            <button
              type="button"
              onClick={() => openEvidence(primary)}
              className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 text-[11px]"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Inspect Source</span>
            </button>
          </div>
        </div>

        {/* Document B Evidence */}
        <div className="p-3 bg-neutral-950/70 border border-neutral-800 rounded-lg flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-neutral-400 text-[11px] mb-1">
              <span className="font-semibold text-neutral-200">Source B</span>
              <span className="font-mono">Page {secondary.page_number}</span>
            </div>
            <div className="font-mono text-neutral-300 text-[11px] truncate mb-2">
              {secondary.filename || secondary.source_id}
            </div>
            <EvidenceHover
              evidence={secondary}
              as="div"
              className="p-2.5 bg-neutral-900 rounded border border-neutral-800/80 font-mono text-neutral-100 text-xs"
            >
              "{secondary.text_excerpt}"
            </EvidenceHover>
          </div>
          <div className="mt-3 pt-2 border-t border-neutral-800/60 flex items-center justify-between">
            <span className="text-neutral-500 font-mono text-[11px]">
              Conf: {Math.round(secondary.confidence * 100)}%
            </span>
            <button
              type="button"
              onClick={() => openEvidence(secondary)}
              className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 text-[11px]"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Inspect Source</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};