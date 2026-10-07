import React from "react";
import { Lock } from "lucide-react";

interface LockedCellProps {
  label?: string;
  onRequestAccess?: () => void;
  compact?: boolean;
}

/**
 * Draws a striped/blurred placeholder around nothing.
 * Never requests, stores, or renders hidden data.
 */
export const LockedCell: React.FC<LockedCellProps> = ({
  label = "Restricted",
  onRequestAccess,
  compact = false,
}) => {
  return (
    <div
      className={`relative inline-flex items-center justify-center overflow-hidden rounded bg-neutral-900/60 border border-neutral-800/80 select-none ${
        compact ? "px-2 py-1 text-[11px]" : "px-3 py-1.5 text-xs w-full min-h-[32px]"
      }`}
      style={{
        backgroundImage:
          "repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.03) 8px, transparent 8px, transparent 16px)",
      }}
      title="Restricted by column-level access policy"
    >
      <div className="flex items-center gap-1.5 text-neutral-400">
        <Lock className="w-3 h-3 text-amber-400/80 shrink-0" />
        <span className="font-mono text-neutral-400 truncate tracking-wide">
          {label}
        </span>
      </div>
      {onRequestAccess && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRequestAccess();
          }}
          className="ml-2 text-[10px] text-amber-400 hover:text-amber-300 underline underline-offset-2"
        >
          Request
        </button>
      )}
    </div>
  );
};
