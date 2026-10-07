import React, { useState } from "react";
import { CheckCircle2, XCircle, Clock, Shield } from "lucide-react";
import type { AccessRequestItem } from "../../agents/23_accessControl";
import { formatBackendDate } from "../../lib/formatters";

interface AccessRequestsQueueProps {
  requests: AccessRequestItem[];
  onDecide: (requestId: string, decision: "approve" | "reject", validUntil?: string, notes?: string) => Promise<void>;
  isProcessing?: boolean;
}

export const AccessRequestsQueue: React.FC<AccessRequestsQueueProps> = ({
  requests,
  onDecide,
  isProcessing = false,
}) => {
  const [activeValidity, setActiveValidity] = useState<Record<string, string>>({});
  const [activeNotes, setActiveNotes] = useState<Record<string, string>>({});

  const handleValidityChange = (id: string, val: string) => {
    setActiveValidity((prev) => ({ ...prev, [id]: val }));
  };

  const handleNotesChange = (id: string, val: string) => {
    setActiveNotes((prev) => ({ ...prev, [id]: val }));
  };

  if (!requests || requests.length === 0) {
    return (
      <div className="p-8 text-center text-neutral-500 bg-neutral-900/40 border border-neutral-800 rounded-xl text-xs">
        No pending access elevation requests in queue.
      </div>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      {requests.map((req) => (
        <div
          key={req.request_id}
          className="p-4 bg-neutral-950/70 border border-neutral-800 rounded-xl space-y-3"
        >
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-amber-400" />
              <span className="font-semibold text-neutral-200">
                Resource: {req.resource_id}
              </span>
              <span className="px-2 py-0.5 rounded border border-neutral-700 bg-neutral-900 text-neutral-300 font-mono text-[10px]">
                Status: {req.status}
              </span>
            </div>

            <div className="font-mono text-[11px] text-neutral-400 flex items-center gap-1">
              <Clock className="w-3 h-3 text-neutral-500" />
              <span>Requested: {formatBackendDate(req.requested_at)}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
            <div>
              <span className="text-neutral-500 font-medium">User:</span>{" "}
              <span className="font-mono text-neutral-300">{req.user_id}</span>
            </div>
            {req.columns && req.columns.length > 0 && (
              <div>
                <span className="text-neutral-500 font-medium">Columns:</span>{" "}
                <span className="font-mono text-neutral-300">{req.columns.join(", ")}</span>
              </div>
            )}
          </div>

          <div className="p-2.5 bg-neutral-900/80 rounded border border-neutral-800 text-neutral-300">
            <span className="text-neutral-500 font-medium">Justification:</span> "{req.reason}"
          </div>

          {/* Decision controls */}
          <div className="pt-2 border-t border-neutral-800 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div>
                <label className="text-[10px] text-neutral-500 block">Validity Expiration</label>
                <input
                  type="datetime-local"
                  value={activeValidity[req.request_id] || ""}
                  onChange={(e) => handleValidityChange(req.request_id, e.target.value)}
                  className="bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-neutral-200 text-xs"
                />
              </div>

              <div>
                <label className="text-[10px] text-neutral-500 block">Decision Note</label>
                <input
                  type="text"
                  placeholder="Optional note..."
                  value={activeNotes[req.request_id] || ""}
                  onChange={(e) => handleNotesChange(req.request_id, e.target.value)}
                  className="bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-neutral-200 text-xs w-48"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  onDecide(req.request_id, "reject", undefined, activeNotes[req.request_id])
                }
                disabled={isProcessing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-rose-800/60 text-rose-300 hover:bg-rose-950/40 font-medium"
              >
                <XCircle className="w-3.5 h-3.5" />
                <span>Reject</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  onDecide(
                    req.request_id,
                    "approve",
                    activeValidity[req.request_id] || undefined,
                    activeNotes[req.request_id]
                  )
                }
                disabled={isProcessing}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Approve Elevation</span>
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
