import React from "react";
import { Link2, AlertCircle } from "lucide-react";
import type { NormalizedFact } from "../../agents/15_factNormalizer";
import { useEvidence } from "../../context/EvidenceContext";
import { ConfidenceIndicator } from "../common/ConfidenceIndicator";

interface FactListProps {
  facts: NormalizedFact[];
}

export const FactList: React.FC<FactListProps> = ({ facts }) => {
  const { openEvidence } = useEvidence();

  if (!facts || facts.length === 0) {
    return <div className="p-4 text-center text-neutral-500 text-xs">No facts extracted for this case.</div>;
  }

  return (
    <div className="space-y-3">
      {facts.map((fact) => (
        <div
          key={fact.fact_id}
          className="p-3.5 bg-neutral-950/60 border border-neutral-800 rounded-xl space-y-2 text-xs"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold text-neutral-200">{fact.subject}</div>
              <div className="text-[11px] text-neutral-400 font-medium">{fact.metric}</div>
            </div>
            <ConfidenceIndicator confidence={fact.confidence} size="sm" />
          </div>

          {/* Raw vs Normalized */}
          <div className="grid grid-cols-2 gap-2 p-2 bg-neutral-900/80 rounded border border-neutral-800/80 font-mono text-[11px]">
            <div>
              <div className="text-[10px] text-neutral-500 uppercase font-sans">Raw Input</div>
              <div className="text-neutral-300 truncate">{fact.raw_text || fact.raw_value}</div>
            </div>
            <div>
              <div className="text-[10px] text-neutral-500 uppercase font-sans">Normalized</div>
              <div className="text-neutral-100 font-semibold truncate">
                {String(fact.normalized_value)}
                {fact.currency && ` ${fact.currency}`}
                {fact.unit && ` ${fact.unit}`}
              </div>
            </div>
          </div>

          {/* Ambiguity notes if any */}
          {fact.ambiguity_notes && fact.ambiguity_notes.length > 0 && (
            <div className="space-y-1">
              {fact.ambiguity_notes.map((note, idx) => (
                <div
                  key={idx}
                  className="p-1.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[11px] flex items-center gap-1.5"
                >
                  <AlertCircle className="w-3 h-3 text-amber-400 shrink-0" />
                  <span>{note}</span>
                </div>
              ))}
            </div>
          )}

          {/* Supporting Evidence List */}
          {fact.evidence && fact.evidence.length > 0 && (
            <div className="pt-1 flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-neutral-500">Evidence:</span>
              {fact.evidence.map((ev, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => openEvidence(ev)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-sky-400 hover:text-sky-300 font-mono text-[11px] transition-colors"
                >
                  <Link2 className="w-2.5 h-2.5" />
                  <span>p.{ev.page_number}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
