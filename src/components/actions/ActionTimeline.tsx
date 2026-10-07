import React from "react";
import { KeyRound, Clock } from "lucide-react";
import type { ApprovalEvent, ApprovalSignature } from "../../agents/18_humanApproval";
import { formatBackendDate } from "../../lib/formatters";

interface ActionTimelineProps {
  events?: ApprovalEvent[];
  signature?: ApprovalSignature;
}

export const ActionTimeline: React.FC<ActionTimelineProps> = ({ events = [], signature }) => {
  return (
    <div className="p-4 bg-neutral-950/60 border border-neutral-800 rounded-xl space-y-4 text-xs">
      {/* Cryptographic Signature Card */}
      {signature && (
        <div className="p-3 bg-neutral-900 border border-neutral-800 rounded-lg space-y-1">
          <div className="flex items-center gap-1.5 text-neutral-200 font-semibold">
            <KeyRound className="w-3.5 h-3.5 text-emerald-400" />
            <span>Cryptographic Governance Signature</span>
          </div>
          <div className="font-mono text-[11px] text-neutral-400 space-y-0.5">
            <div>Signed by: <span className="text-neutral-200">{signature.signed_by}</span></div>
            <div>Algorithm: <span className="text-neutral-200">{signature.algorithm}</span></div>
            <div className="truncate">Signature value: <span className="text-neutral-300">{signature.value}</span></div>
          </div>
        </div>
      )}

      {/* Events Timeline */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" />
          <span>Governance Audit Trail</span>
        </div>

        {events.length === 0 ? (
          <div className="p-3 text-center text-neutral-500 bg-neutral-950/40 rounded">
            No approval lifecycle events recorded.
          </div>
        ) : (
          <div className="space-y-2 border-l border-neutral-800 pl-3 ml-2">
            {events.map((ev) => (
              <div key={ev.event_id} className="relative space-y-1">
                <div className="absolute -left-[19px] top-1 w-2.5 h-2.5 rounded-full bg-sky-500 border-2 border-neutral-950" />
                <div className="flex items-center justify-between">
                  <span className="font-medium text-neutral-200 capitalize">
                    {ev.event_type.replace(/_/g, " ")}
                  </span>
                  <span className="font-mono text-[10px] text-neutral-500">
                    {formatBackendDate(ev.event_timestamp)}
                  </span>
                </div>
                <div className="text-[11px] text-neutral-400 font-mono">
                  Actor: {ev.actor_id} ({ev.actor_role}) · Transition: {ev.previous_status} → {ev.new_status}
                </div>
                {ev.notes && (
                  <div className="p-1.5 bg-neutral-900/60 rounded text-neutral-300 text-[11px]">
                    "{ev.notes}"
                  </div>
                )}
                {ev.content_hash && (
                  <div className="text-[10px] font-mono text-neutral-500 truncate">
                    Hash: {ev.content_hash}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
