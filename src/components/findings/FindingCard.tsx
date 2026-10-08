import React from "react";
import { AlertCircle, Link2, FileText, CheckCircle } from "lucide-react";
import type { DiscrepancyFinding } from "../../agents/16_crossDocReasoning";
import { ConfidenceIndicator } from "../common/ConfidenceIndicator";
import { useEvidence } from "../../context/EvidenceContext";
import { useAuth } from "../../context/AuthContext";
import { CAPABILITY_KEYS } from "../../config/capabilityKeys";
import { EvidenceHover } from "../evidence/EvidenceHover";
import { HighlightScope } from "../evidence/HighlightScope";

interface FindingCardProps {
  finding: DiscrepancyFinding;
  onRequestActionDraft?: (finding: DiscrepancyFinding) => void;
  onAcknowledge?: (findingId: string) => void;
  onDismiss?: (findingId: string) => void;
}

export const FindingCard: React.FC<FindingCardProps> = ({
  finding,
  onRequestActionDraft,
  onAcknowledge,
  onDismiss,
}) => {
  const { openEvidence } = useEvidence();
  const { hasCapability } = useAuth();

  const canDecide = hasCapability(CAPABILITY_KEYS.CASE_DECISION);
  const canDraftAction = hasCapability(CAPABILITY_KEYS.ACTION_DRAFT);

  return (
    <HighlightScope
      evidences={finding.evidence_references}
      className="p-4 bg-neutral-950/70 border border-neutral-800 rounded-xl space-y-3 text-xs"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-neutral-100 text-sm">
              {finding.title}
            </span>
            <span className="px-2 py-0.5 rounded border border-neutral-700 bg-neutral-900 text-neutral-300 font-mono text-[10px] uppercase">
              {finding.severity}
            </span>
          </div>
          <div className="text-[11px] text-neutral-400">
            Category: <span className="text-neutral-200">{finding.category}</span>
          </div>
        </div>

        <ConfidenceIndicator confidence={finding.confidence} size="sm" />
      </div>

      {/* Neutral Statement */}
      <div className="p-3 bg-neutral-900/70 rounded-lg border border-neutral-800 text-neutral-200">
        {finding.statement}
      </div>

      {/* Differences (if present) */}
      {(finding.difference_absolute !== undefined || finding.difference_percentage !== undefined) && (
        <div className="grid grid-cols-2 gap-2 p-2 bg-neutral-900/40 rounded border border-neutral-800/80 font-mono text-[11px]">
          {finding.difference_absolute !== undefined && (
            <div>
              <span className="text-neutral-500 font-sans">Variance (Abs):</span>{" "}
              <span className="text-neutral-200 tabular-nums">
                {finding.difference_absolute.toLocaleString()}
              </span>
            </div>
          )}
          {finding.difference_percentage !== undefined && (
            <div>
              <span className="text-neutral-500 font-sans">Variance (%):</span>{" "}
              <span className="text-neutral-200 tabular-nums">
                {finding.difference_percentage.toFixed(2)}%
              </span>
            </div>
          )}
        </div>
      )}

      {/* Human review recommended notification */}
      {finding.human_review_required && (
        <div className="p-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[11px] flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span>Manual review recommended — no final decision has been made.</span>
        </div>
      )}

      {/* Possible Explanations */}
      {finding.possible_explanations && finding.possible_explanations.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] font-semibold text-neutral-500 uppercase">
            Potential Explanations
          </span>
          <ul className="list-disc list-inside space-y-0.5 text-neutral-400 text-[11px]">
            {finding.possible_explanations.map((exp, idx) => (
              <li key={idx}>{exp}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Recommended Review Action */}
      {finding.recommended_review_action && (
        <div className="text-[11px] text-neutral-300">
          <span className="text-neutral-500 font-medium">Suggested Next Step:</span>{" "}
          {finding.recommended_review_action}
        </div>
      )}

      {/* Evidence References */}
      {finding.evidence_references && finding.evidence_references.length > 0 && (
        <div className="pt-1 flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-neutral-500">Supporting Evidence:</span>
          {finding.evidence_references.map((ev, idx) => (
            <EvidenceHover key={idx} evidence={ev} focusable={false} openOnClick={false}>
              <button
                type="button"
                onClick={() => openEvidence(ev)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-sky-400 hover:text-sky-300 font-mono text-[11px] transition-colors"
              >
                <Link2 className="w-2.5 h-2.5" />
                <span>{ev.filename || ev.source_id} p.{ev.page_number}</span>
              </button>
            </EvidenceHover>
          ))}
        </div>
      )}

      {/* Review Controls driven solely by capabilities */}
      <div className="pt-2 border-t border-neutral-800 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {canDecide && (
            <>
              <button
                type="button"
                onClick={() => onAcknowledge?.(finding.finding_id)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 text-neutral-200 transition-colors"
              >
                <CheckCircle className="w-3 h-3 text-emerald-400" />
                <span>Acknowledge</span>
              </button>
              <button
                type="button"
                onClick={() => onDismiss?.(finding.finding_id)}
                className="px-2.5 py-1 rounded hover:bg-neutral-900 text-neutral-400 hover:text-neutral-200 transition-colors"
              >
                Dismiss with Note
              </button>
            </>
          )}
        </div>

        {canDraftAction && (
          <button
            type="button"
            onClick={() => onRequestActionDraft?.(finding)}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-sky-600/30 hover:bg-sky-600/40 border border-sky-500/40 text-sky-200 font-medium transition-colors"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Request Action Draft</span>
          </button>
        )}
      </div>
    </HighlightScope>
  );
};