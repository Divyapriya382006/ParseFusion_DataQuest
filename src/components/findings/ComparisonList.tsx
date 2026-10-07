import React from "react";
import { CheckCircle2, XCircle, ArrowRightLeft } from "lucide-react";
import type { FactComparison, NotComparableFactGroup } from "../../agents/16_crossDocReasoning";

interface ComparisonListProps {
  comparisons: FactComparison[];
  notComparable: NotComparableFactGroup[];
}

export const ComparisonList: React.FC<ComparisonListProps> = ({
  comparisons,
  notComparable,
}) => {
  return (
    <div className="space-y-4 text-xs">
      {/* Comparable sets */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
          Comparable Fact Sets ({comparisons.length})
        </div>

        {comparisons.length === 0 ? (
          <div className="p-3 text-center text-neutral-500 bg-neutral-950/40 rounded-lg">
            No comparable sets evaluated.
          </div>
        ) : (
          comparisons.map((c) => (
            <div
              key={c.comparison_id}
              className="p-3 bg-neutral-950/60 border border-neutral-800 rounded-xl space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 font-mono text-[11px] text-neutral-300">
                  <ArrowRightLeft className="w-3.5 h-3.5 text-sky-400" />
                  <span>{c.comparison_id}</span>
                </div>
                <div className="flex items-center gap-1 text-emerald-400 font-medium text-[11px]">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Comparable Basis</span>
                </div>
              </div>

              <div className="font-mono text-[11px] text-neutral-400">
                Facts: {c.fact_ids.join(", ")}
              </div>

              {c.checks && c.checks.length > 0 && (
                <div className="space-y-1 pt-1">
                  {c.checks.map((chk, idx) => (
                    <div
                      key={idx}
                      className="p-1.5 bg-neutral-900/60 rounded border border-neutral-800/80 flex items-center justify-between text-[11px]"
                    >
                      <span className="text-neutral-300">{chk.name}</span>
                      <span className="font-mono text-neutral-400">{chk.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Non-Comparable Sets */}
      {notComparable && notComparable.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
            Information Requiring Clarification / Not Comparable ({notComparable.length})
          </div>
          {notComparable.map((nc, idx) => (
            <div
              key={idx}
              className="p-3 bg-neutral-950/60 border border-amber-500/20 rounded-xl space-y-1.5"
            >
              <div className="flex items-center gap-1.5 text-amber-300 font-medium">
                <XCircle className="w-3.5 h-3.5 text-amber-400" />
                <span>Basis Mismatch</span>
              </div>
              <div className="font-mono text-[11px] text-neutral-400">
                Facts: {nc.fact_ids.join(", ")}
              </div>
              <div className="text-neutral-300 text-[11px] bg-neutral-900/60 p-2 rounded border border-neutral-800">
                {nc.reason}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
