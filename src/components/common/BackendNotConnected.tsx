import React from "react";
import { ServerOff, RefreshCw, Terminal } from "lucide-react";
import { getApiBaseUrl } from "../../api/client";

interface BackendNotConnectedProps {
  endpoint: string;
  onRetry?: () => void;
  message?: string;
  detail?: string;
}

export const BackendNotConnected: React.FC<BackendNotConnectedProps> = ({
  endpoint,
  onRetry,
  message,
  detail,
}) => {
  const currentBaseUrl = getApiBaseUrl();

  return (
    <div className="flex flex-col items-center justify-center min-h-[340px] p-8 text-center bg-neutral-900/40 border border-neutral-800 rounded-xl my-4">
      <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 mb-4">
        <ServerOff className="w-6 h-6" />
      </div>

      <h3 className="text-lg font-semibold text-neutral-100 mb-1">
        Backend not connected: {endpoint}
      </h3>

      <p className="text-sm text-neutral-400 max-w-md mb-4">
        {message || "The application is awaiting communication with this agent endpoint."}
      </p>
      {detail && (
        <p className="text-xs text-amber-300 max-w-lg mb-4" role="status">
          {detail}
        </p>
      )}

      <div className="w-full max-w-lg bg-neutral-950 border border-neutral-800 rounded-lg p-3 text-left mb-6 font-mono text-xs text-neutral-300">
        <div className="flex items-center gap-2 text-neutral-500 mb-2 font-sans text-xs">
          <Terminal className="w-3.5 h-3.5" />
          <span>Connection Diagnostic</span>
        </div>
        <div className="space-y-1">
          <div><span className="text-neutral-500">Configured Base URL:</span> {currentBaseUrl || "<unset>"}</div>
          <div><span className="text-neutral-500">Target Endpoint:</span> {endpoint}</div>
          <div><span className="text-neutral-500">Environment Key:</span> VITE_API_BASE_URL</div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Retry Connection
          </button>
        )}
      </div>
    </div>
  );
};
