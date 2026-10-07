import React, { useState } from "react";
import { Modal } from "../common/Modal";
import { ShieldCheck, Send } from "lucide-react";
import type { ID } from "../../types/canonical";

interface RequestAccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  resourceId: ID;
  tableName: string;
  selectedColumns?: string[];
  onSubmit: (reason: string, duration?: string, columns?: string[]) => Promise<void>;
}

export const RequestAccessModal: React.FC<RequestAccessModalProps> = ({
  isOpen,
  onClose,
  resourceId,
  tableName,
  selectedColumns = [],
  onSubmit,
}) => {
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState("24h");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;
    try {
      setIsSubmitting(true);
      await onSubmit(reason, duration, selectedColumns.length > 0 ? selectedColumns : undefined);
      setReason("");
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Request Access: ${tableName} (${resourceId})`}
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4 text-xs">
        <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-300">
          <div className="flex items-center gap-1.5 font-medium mb-1">
            <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
            <span>Governed Access Protocol</span>
          </div>
          <div>
            Requests require human supervisor approval and cryptographic audit event creation.
          </div>
        </div>

        {selectedColumns.length > 0 && (
          <div>
            <label className="text-neutral-400 font-medium">Target Columns</label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {selectedColumns.map((c) => (
                <span
                  key={c}
                  className="px-2 py-0.5 rounded bg-neutral-900 border border-neutral-700 font-mono text-neutral-200 text-[11px]"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="text-neutral-300 font-medium">Business Justification *</label>
          <textarea
            required
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain why this data is required for the investigation..."
            className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded p-2.5 text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 text-xs"
          />
        </div>

        <div>
          <label className="text-neutral-300 font-medium">Requested Duration</label>
          <select
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded px-2.5 py-1.5 text-neutral-200 text-xs"
          >
            <option value="1h">1 Hour (Immediate Inspection)</option>
            <option value="8h">8 Hours (Working Shift)</option>
            <option value="24h">24 Hours (1 Day)</option>
            <option value="7d">7 Days (Case Cycle)</option>
          </select>
        </div>

        <div className="pt-2 flex items-center justify-end gap-2 border-t border-neutral-800">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded hover:bg-neutral-800 text-neutral-400"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting || !reason.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Submit Elevation Request</span>
          </button>
        </div>
      </form>
    </Modal>
  );
};
