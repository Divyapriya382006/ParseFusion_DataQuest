import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { ApiError } from "../../types/canonical";

interface ErrorAlertProps {
  error?: ApiError | Error | null;
  requestId?: string;
  onRetry?: () => void;
  title?: string;
}

export const ErrorAlert: React.FC<ErrorAlertProps> = ({
  error,
  requestId,
  onRetry,
  title = "Operation Encountered an Issue",
}) => {
  if (!error) return null;

  const code =
    "code" in error && typeof error.code === "string"
      ? error.code
      : "name" in error && typeof error.name === "string"
      ? error.name
      : "ERROR";
  const message = error.message || "An unexpected error response was returned by the system.";
  const details = "details" in error ? error.details : undefined;

  return (
    <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-950/20 text-rose-200 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold text-rose-300 text-sm">{title}</div>
            <div className="mt-1 text-rose-300/80">{message}</div>

            <div className="mt-2.5 flex flex-wrap items-center gap-3 font-mono text-[11px] text-rose-400/80">
              <span>Code: {code}</span>
              {requestId && <span>Request ID: {requestId}</span>}
            </div>

            {details && Object.keys(details).length > 0 && (
              <pre className="mt-2 p-2 bg-neutral-950/60 rounded border border-rose-900/40 text-[11px] overflow-x-auto text-rose-300">
                {JSON.stringify(details, null, 2)}
              </pre>
            )}
          </div>
        </div>

        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 text-rose-200 transition-colors shrink-0 text-xs font-medium"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Retry
          </button>
        )}
      </div>
    </div>
  );
};
