import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText, ShieldCheck, ShieldAlert, ArrowRight, Filter } from "lucide-react";
import { fetchAuditLog } from "../agents/19_audit";
import { BackendNotConnected } from "../components/common/BackendNotConnected";
import { formatBackendDate } from "../lib/formatters";
import { Skeleton } from "../components/common/LoadingSkeleton";

export const AuditLogPage: React.FC = () => {
  const [actor, setActor] = useState("");
  const [eventType, setEventType] = useState("");
  const [caseId, setCaseId] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const {
    data: auditData,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["auditLog", actor, eventType, caseId, cursor],
    queryFn: ({ signal }) =>
      fetchAuditLog(
        {
          actor: actor || undefined,
          event_type: eventType || undefined,
          case_id: caseId || undefined,
          cursor,
        },
        signal
      ),
  });

  if (isError) {
    return (
      <div className="p-8 max-w-6xl mx-auto space-y-4">
        <h1 className="text-xl font-bold text-neutral-100">Cryptographic Audit Trail</h1>
        <BackendNotConnected
          endpoint="/agents/audit"
          onRetry={() => refetch()}
          message="Could not load the immutable audit ledger from the backend."
        />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-neutral-100 flex items-center gap-2">
            <ScrollText className="w-5 h-5 text-sky-400" />
            <span>Immutable Audit Trail & Ledger</span>
          </h1>
          <p className="text-xs text-neutral-400 mt-1">
            Tamper-evident record of all extractor jury decisions, document ingestions, and approvals.
          </p>
        </div>

        {/* Chain validity indicator */}
        {auditData && (
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border font-mono text-xs ${
              auditData.chain_valid
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                : "bg-rose-500/10 border-rose-500/30 text-rose-400"
            }`}
          >
            {auditData.chain_valid ? (
              <>
                <ShieldCheck className="w-4 h-4" />
                <span>Merkle Chain Cryptographically Valid</span>
              </>
            ) : (
              <>
                <ShieldAlert className="w-4 h-4" />
                <span>Chain Discrepancy Detected</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Filter Bar */}
      <div className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1.5 text-neutral-400">
          <Filter className="w-3.5 h-3.5" />
          <span className="font-semibold uppercase tracking-wider text-[11px]">Filters:</span>
        </div>

        <input
          type="text"
          placeholder="Actor ID..."
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          className="bg-neutral-950 border border-neutral-800 rounded px-2.5 py-1 text-neutral-200 text-xs w-32"
        />

        <input
          type="text"
          placeholder="Event Type..."
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          className="bg-neutral-950 border border-neutral-800 rounded px-2.5 py-1 text-neutral-200 text-xs w-40"
        />

        <input
          type="text"
          placeholder="Case ID..."
          value={caseId}
          onChange={(e) => setCaseId(e.target.value)}
          className="bg-neutral-950 border border-neutral-800 rounded px-2.5 py-1 text-neutral-200 text-xs w-32"
        />

        {(actor || eventType || caseId) && (
          <button
            type="button"
            onClick={() => {
              setActor("");
              setEventType("");
              setCaseId("");
              setCursor(undefined);
            }}
            className="text-neutral-500 hover:text-neutral-300 text-xs underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Audit Events Table */}
      {isLoading ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : auditData?.events && auditData.events.length > 0 ? (
        <div className="border border-neutral-800 rounded-xl overflow-hidden bg-neutral-950/60">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[11px] text-left">
              <thead>
                <tr className="bg-neutral-900/80 border-b border-neutral-800 text-neutral-400">
                  <th className="p-3">Timestamp</th>
                  <th className="p-3">Event Type</th>
                  <th className="p-3">Actor</th>
                  <th className="p-3">Target Object</th>
                  <th className="p-3">Block Hash</th>
                  <th className="p-3">Prev Hash</th>
                </tr>
              </thead>
              <tbody>
                {auditData.events.map((ev) => (
                  <tr
                    key={ev.event_id}
                    className="border-b border-neutral-800/40 hover:bg-neutral-800/20 text-neutral-300"
                  >
                    <td className="p-3 whitespace-nowrap text-neutral-400">
                      {formatBackendDate(ev.timestamp)}
                    </td>
                    <td className="p-3 font-semibold text-neutral-200">
                      {ev.event_type}
                    </td>
                    <td className="p-3 text-neutral-300">
                      {ev.actor_id} ({ev.actor_role})
                    </td>
                    <td className="p-3 text-neutral-400">
                      {ev.object_type}: {ev.object_id}
                    </td>
                    <td className="p-3 text-sky-400 truncate max-w-[120px]" title={ev.hash}>
                      {ev.hash.substring(0, 10)}...
                    </td>
                    <td className="p-3 text-neutral-500 truncate max-w-[120px]" title={ev.prev_hash}>
                      {ev.prev_hash.substring(0, 10)}...
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {auditData.next_cursor && (
            <div className="p-3 border-t border-neutral-800 flex justify-end">
              <button
                type="button"
                onClick={() => setCursor(auditData.next_cursor)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-neutral-850 hover:bg-neutral-800 text-neutral-200"
              >
                <span>Next Page</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="p-8 text-center text-neutral-500 bg-neutral-900/40 border border-neutral-800 rounded-xl">
          No audit events recorded matching current criteria.
        </div>
      )}
    </div>
  );
};
