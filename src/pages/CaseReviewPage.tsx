import React, { useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  FolderGit2,
  FileText,
  CheckCircle2,
  XCircle,
  Plus,
  Scale,
  Sparkles,
} from "lucide-react";
import { listCases, getCase } from "../api/cases";
import { decideCaseLink, linkCaseDocuments } from "../agents/14_caseLinker";
import type { CaseLink } from "../agents/14_caseLinker";
import { normalizeFacts } from "../agents/15_factNormalizer";
import { reasonCrossDoc } from "../agents/16_crossDocReasoning";
import type { DiscrepancyFinding } from "../agents/16_crossDocReasoning";
import { draftAction } from "../agents/17_actionDraft";
import { BackendNotConnected } from "../components/common/BackendNotConnected";
import { SideBySideCompare } from "../components/findings/SideBySideCompare";
import { FactList } from "../components/findings/FactList";
import { ComparisonList } from "../components/findings/ComparisonList";
import { FindingCard } from "../components/findings/FindingCard";
import { Skeleton } from "../components/common/LoadingSkeleton";
import { formatBackendDate } from "../lib/formatters";
import type { EvidenceReference } from "../types/canonical";

export const CaseReviewPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const requestedCaseId = searchParams.get("case_id") || "";

  // Cases List
  const { data: casesData, isError: casesListError, refetch: refetchCases } = useQuery({
    queryKey: ["casesList"],
    queryFn: ({ signal }) => listCases(signal),
  });

  const activeCaseId = requestedCaseId || casesData?.cases?.[0]?.case_id || "";

  // Selected Case Record
  const { data: caseRecord, isError: caseRecordError, refetch: refetchCase } = useQuery({
    queryKey: ["caseRecord", activeCaseId],
    queryFn: ({ signal }) => getCase(activeCaseId, signal),
    enabled: Boolean(activeCaseId),
  });

  // Agent 14: Linked Documents
  const { data: linkData, refetch: refetchLinks } = useQuery({
    queryKey: ["caseLinks", activeCaseId],
    queryFn: ({ signal }) =>
      linkCaseDocuments({ case_id: activeCaseId, source_ids: [], mode: "suggest" }, signal),
    enabled: Boolean(activeCaseId),
  });

  // Agent 15: Normalized Facts
  const { data: factData, refetch: refetchFacts } = useQuery({
    queryKey: ["caseFacts", activeCaseId],
    queryFn: ({ signal }) => normalizeFacts({ case_id: activeCaseId }, signal),
    enabled: Boolean(activeCaseId),
  });

  // Agent 16: Cross-Document Reasoning & Potential Discrepancies
  const { data: reasoningData, refetch: refetchReasoning } = useQuery({
    queryKey: ["caseReasoning", activeCaseId],
    queryFn: ({ signal }) => reasonCrossDoc({ case_id: activeCaseId }, signal),
    enabled: Boolean(activeCaseId),
  });

  // Dual-pane compare state
  const [compareRefs, setCompareRefs] = useState<{
    primary: EvidenceReference;
    secondary: EvidenceReference;
  } | null>(null);

  // Right pane tab
  const [rightTab, setRightTab] = useState<"findings" | "facts" | "comparisons">("findings");

  const handleLinkDecision = async (linkId: string, decision: "confirm" | "reject") => {
    await decideCaseLink({ link_id: linkId, decision });
    refetchLinks();
  };

  const handleRequestActionDraft = async (finding: DiscrepancyFinding) => {
    const actionRes = await draftAction({
      case_id: activeCaseId,
      finding_id: finding.finding_id,
      action_type: "request_clarification",
    });
    navigate(`/actions?action_id=${actionRes.action_id}`);
  };

  if (casesListError || caseRecordError) {
    return (
      <div className="p-8 max-w-6xl mx-auto space-y-4">
        <h1 className="text-xl font-bold text-neutral-100">Case Investigation & Review</h1>
        <BackendNotConnected
          endpoint={activeCaseId ? `/cases/${activeCaseId}` : "/cases"}
          onRetry={() => {
            refetchCases();
            if (activeCaseId) refetchCase();
          }}
          message="Could not retrieve the case investigation records from the backend."
        />
      </div>
    );
  }

  // Setup sample side-by-side comparison if findings carry multiple evidence references
  const firstFindingWithEvidence = reasoningData?.findings?.find(
    (f) => f.evidence_references && f.evidence_references.length >= 2
  );

  const activeComparePrimary =
    compareRefs?.primary || firstFindingWithEvidence?.evidence_references?.[0];
  const activeCompareSecondary =
    compareRefs?.secondary || firstFindingWithEvidence?.evidence_references?.[1];

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden text-xs">
      {/* Top Header Bar */}
      <div className="h-14 border-b border-neutral-800 bg-neutral-900/60 px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <FolderGit2 className="w-4 h-4 text-sky-400" />
          <h1 className="font-semibold text-neutral-100 text-sm">
            Case Review: {caseRecord?.title || activeCaseId || "Investigation"}
          </h1>
          {caseRecord && (
            <span className="font-mono text-[11px] text-neutral-400">
              ID: {caseRecord.case_id} · Status: {caseRecord.status}
            </span>
          )}
        </div>

        {/* Case Switcher */}
        {casesData?.cases && casesData.cases.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-neutral-400">Case:</span>
            <select
              value={activeCaseId}
              onChange={(e) => {
                navigate(`/cases?case_id=${e.target.value}`);
              }}
              className="bg-neutral-950 border border-neutral-800 rounded px-2.5 py-1 text-neutral-200 text-xs"
            >
              {casesData.cases.map((c) => (
                <option key={c.case_id} value={c.case_id}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* 3-Pane Body Grid */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden min-h-0">
        {/* Pane 1: Left (Case metadata, linked docs, suggested links, timeline) */}
        <div className="lg:col-span-3 border-r border-neutral-800 bg-neutral-950/40 p-4 overflow-y-auto space-y-5">
          {/* Metadata */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
              Investigation Metadata
            </div>
            <div className="p-3 bg-neutral-900/80 border border-neutral-800 rounded-lg space-y-1.5 font-mono text-[11px]">
              <div>
                <span className="text-neutral-500">Created:</span>{" "}
                <span className="text-neutral-300">
                  {formatBackendDate(caseRecord?.created_at)}
                </span>
              </div>
              <div>
                <span className="text-neutral-500">Updated:</span>{" "}
                <span className="text-neutral-300">
                  {formatBackendDate(caseRecord?.updated_at)}
                </span>
              </div>
              <div>
                <span className="text-neutral-500">Documents:</span>{" "}
                <span className="text-neutral-200">{caseRecord?.source_ids?.length || 0}</span>
              </div>
            </div>
          </div>

          {/* Linked Documents (Agent 14) */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider flex items-center justify-between">
              <span>Linked Documents</span>
              <span className="font-mono text-neutral-500">{linkData?.links?.length || 0}</span>
            </div>

            {linkData?.links?.length === 0 ? (
              <div className="p-3 text-center text-neutral-500 bg-neutral-900/40 rounded">
                No documents linked to case.
              </div>
            ) : (
              <div className="space-y-2">
                {linkData?.links?.map((lnk: CaseLink) => (
                  <div
                    key={lnk.link_id}
                    className="p-3 bg-neutral-900/80 border border-neutral-800 rounded-lg space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-neutral-200 truncate max-w-[140px]">
                        {lnk.source_id}
                      </span>
                      {lnk.human_verified ? (
                        <span className="text-emerald-400 font-mono text-[10px]">Verified</span>
                      ) : (
                        <span className="text-amber-400 font-mono text-[10px]">Suggested</span>
                      )}
                    </div>

                    <div className="text-[11px] text-neutral-400">
                      Relation: <span className="text-neutral-300">{lnk.relationship_type}</span>
                    </div>

                    {/* Matching Signals */}
                    {lnk.matching_signals && lnk.matching_signals.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {lnk.matching_signals.map((sig, idx) => (
                          <span
                            key={idx}
                            className="px-1.5 py-0.5 rounded bg-neutral-950 font-mono text-[10px] text-neutral-400"
                          >
                            {sig}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Human Verification decision buttons */}
                    {!lnk.human_verified && (
                      <div className="pt-1.5 border-t border-neutral-800 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleLinkDecision(lnk.link_id, "reject")}
                          className="px-2 py-1 rounded border border-neutral-800 hover:bg-neutral-800 text-neutral-400 text-[11px]"
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          onClick={() => handleLinkDecision(lnk.link_id, "confirm")}
                          className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-[11px]"
                        >
                          Confirm Link
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Pane 2: Center (Side-by-side evidence compare & preview) */}
        <div className="lg:col-span-5 p-4 overflow-y-auto space-y-4 border-r border-neutral-800">
          <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider flex items-center gap-1.5">
            <Scale className="w-3.5 h-3.5 text-sky-400" />
            <span>Cross-Document Evidence Inspection</span>
          </div>

          {activeComparePrimary && activeCompareSecondary ? (
            <SideBySideCompare
              primary={activeComparePrimary}
              secondary={activeCompareSecondary}
            />
          ) : (
            <div className="p-8 text-center text-neutral-500 bg-neutral-900/40 border border-neutral-800 rounded-xl">
              Select a finding or fact with multiple evidence references to compare documents side-by-side.
            </div>
          )}

          {/* Neutral Advisory Note */}
          <div className="p-3 bg-neutral-900/60 border border-neutral-800 rounded-xl text-neutral-400 text-[11px] leading-relaxed">
            All facts and potential discrepancies are presented neutrally. Manual review recommended before final operational decisions.
          </div>
        </div>

        {/* Pane 3: Right (Findings, Facts, Comparisons) */}
        <div className="lg:col-span-4 p-4 overflow-y-auto space-y-4">
          {/* Subtabs */}
          <div className="flex items-center gap-1 border-b border-neutral-800 pb-2">
            <button
              type="button"
              onClick={() => setRightTab("findings")}
              className={`px-3 py-1.5 rounded-lg font-medium text-xs transition-colors ${
                rightTab === "findings"
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              Potential Discrepancies ({reasoningData?.findings?.length || 0})
            </button>
            <button
              type="button"
              onClick={() => setRightTab("facts")}
              className={`px-3 py-1.5 rounded-lg font-medium text-xs transition-colors ${
                rightTab === "facts"
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              Normalized Facts ({factData?.facts?.length || 0})
            </button>
            <button
              type="button"
              onClick={() => setRightTab("comparisons")}
              className={`px-3 py-1.5 rounded-lg font-medium text-xs transition-colors ${
                rightTab === "comparisons"
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              Comparisons
            </button>
          </div>

          {rightTab === "findings" && (
            <div className="space-y-3">
              {reasoningData?.findings?.map((f) => (
                <FindingCard
                  key={f.finding_id}
                  finding={f}
                  onRequestActionDraft={handleRequestActionDraft}
                />
              ))}
            </div>
          )}

          {rightTab === "facts" && (
            <FactList facts={factData?.facts || []} />
          )}

          {rightTab === "comparisons" && (
            <ComparisonList
              comparisons={reasoningData?.comparisons || []}
              notComparable={reasoningData?.not_comparable || []}
            />
          )}
        </div>
      </div>
    </div>
  );
};
