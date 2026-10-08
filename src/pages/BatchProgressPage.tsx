import React, { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  RotateCcw,
  ArrowRight,
  Layers,
  Activity,
  AlertCircle,
  CheckCircle2,
  Download,
} from "lucide-react";
import { getBatch, retryBatchSource } from "../api/batches";
import { getApiUrl } from "../api/client";
import { useConfig } from "../context/ConfigContext";
import { BackendNotConnected } from "../components/common/BackendNotConnected";
import { ErrorAlert } from "../components/common/ErrorAlert";
import { Skeleton } from "../components/common/LoadingSkeleton";
import { formatBackendDate } from "../lib/formatters";
import { NotConnectedError } from "../api/errors";

export const BatchProgressPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const batchId = searchParams.get("id") || "";
  const jobId = searchParams.get("job_id") || "";

  const { config, isNotConnected: configNotConnected } = useConfig();
  const pollInterval = config?.poll_interval_ms || 2000;

  const [retryingSource, setRetryingSource] = useState<string | null>(null);

  const {
    data: batchData,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["batchStatus", batchId],
    queryFn: ({ signal }) => getBatch(batchId, signal),
    enabled: Boolean(batchId) && !configNotConnected,
    // A 404 means the batch does not exist (e.g. the backend restarted): asking again will not change that.
    retry: (count, err) => !(err instanceof NotConnectedError && err.status === 404) && count < 2,
    refetchInterval: (query) => {
      if (query.state.status === "error") return false; // batch gone or backend down: stop polling, show Retry
      const status = query.state.data?.status;
      return status === "completed" || status === "failed" ? false : pollInterval;
    },
  });

  const handleRetry = async (sourceId: string) => {
    try {
      setRetryingSource(sourceId);
      await retryBatchSource(batchId, sourceId);
      refetch();
    } finally {
      setRetryingSource(null);
    }
  };

  if (!batchId) {
    return (
      <div className="p-8 max-w-4xl mx-auto space-y-4 text-xs">
        <h1 className="text-xl font-bold text-neutral-100">Batch Pipeline Tracker</h1>
        <div className="p-6 bg-neutral-900/60 border border-neutral-800 rounded-xl text-center text-neutral-400">
          No batch selected. Launch a pipeline from the Ingestion page or provide a valid batch ID parameter.
          <div className="mt-4">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg font-medium"
            >
              Go to Ingestion
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (isError && error instanceof NotConnectedError && error.status === 404) {
    return (
      <div className="p-8 max-w-4xl mx-auto space-y-4 text-xs">
        <h1 className="text-xl font-bold text-neutral-100">Batch Pipeline Tracker</h1>
        <div className="p-6 bg-neutral-900/60 border border-neutral-800 rounded-xl text-center text-neutral-400 space-y-4">
          <p>
            Batch <span className="font-mono text-neutral-300">{batchId}</span> was not found on the backend. Batches are
            kept in memory, so they are cleared when the backend restarts.
          </p>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg font-medium"
          >
            Start a new run
          </Link>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-8 max-w-4xl mx-auto space-y-4">
        <h1 className="text-xl font-bold text-neutral-100">Batch Pipeline Tracker</h1>
        <BackendNotConnected
          endpoint={`/batches/${batchId}`}
          onRetry={() => refetch()}
          message="Could not poll the batch status from the backend."
        />
        <ErrorAlert error={error as Error} />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 text-xs">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-neutral-100">Pipeline Execution</h1>
            <span className="font-mono text-xs px-2.5 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-300">
              {batchId}
            </span>
          </div>
          <div className="text-neutral-500 font-mono text-[11px] mt-1">
            Job Reference: {jobId || "auto-managed"} · Created: {formatBackendDate(batchData?.created_at)}
          </div>
        </div>

        {batchData?.status === "completed" && (
          <Link
            to={`/dashboard?batch_id=${batchId}`}
            className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium shadow-md transition-colors"
          >
            <span>View Extraction Dashboard</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        )}
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      )}

      {batchData && (
        <>
          {/* Progress Overview Card */}
          <div className="p-5 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-neutral-200">Execution Status:</span>
                <span className="font-mono text-neutral-100 uppercase font-semibold">
                  {batchData.status}
                </span>
                {batchData.stage && (
                  <span className="text-neutral-400 font-mono text-[11px]">
                    ({batchData.stage})
                  </span>
                )}
              </div>

              <div className="font-mono text-neutral-300 text-sm font-semibold tabular-nums">
                {batchData.progress_percent ?? 0}%
              </div>
            </div>

            {/* Progress bar */}
            <div className="w-full bg-neutral-950 rounded-full h-2 overflow-hidden border border-neutral-800">
              <div
                className="bg-sky-500 h-full transition-all duration-300"
                style={{ width: `${batchData.progress_percent ?? 0}%` }}
              />
            </div>

            {batchData.sources_summary && (
              <div className="flex items-center gap-4 text-[11px] font-mono text-neutral-400 pt-1">
                <span>Total: {batchData.sources_summary.total}</span>
                <span className="text-emerald-400">Completed: {batchData.sources_summary.completed}</span>
                <span className="text-rose-400">Failed: {batchData.sources_summary.failed}</span>
              </div>
            )}
          </div>

          {batchData.output_formats && batchData.output_formats.length > 0 && (
            <div className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-3">
              <div>
                <div className="text-[11px] font-semibold text-neutral-300 uppercase tracking-wider">
                  Requested Output Formats
                </div>
                <div className="text-[11px] text-neutral-500 mt-1">
                  {batchData.output_formats.join(", ")}
                  {batchData.stage === "exporting" && " · Generating downloads..."}
                </div>
              </div>

              {batchData.exports && batchData.exports.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {batchData.exports.map((output) => (
                    <a
                      key={output.export_id}
                      href={getApiUrl(output.download_url)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-200"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download {output.format.toUpperCase()}</span>
                    </a>
                  ))}
                </div>
              )}

              {batchData.export_errors && batchData.export_errors.length > 0 && (
                <ul className="space-y-1 text-rose-300" role="alert">
                  {batchData.export_errors.map((failure) => (
                    <li key={`${failure.format}:${failure.code}`}>
                      {failure.format.toUpperCase()} export failed: {failure.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Sources Execution Table */}
          <div className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-3">
            <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-sky-400" />
              <span>Source Documents in Batch ({batchData.source_ids?.length || 0})</span>
            </div>

            <div className="space-y-2">
              {batchData.source_ids?.map((srcId) => (
                <div
                  key={srcId}
                  className="p-3 bg-neutral-950/80 border border-neutral-800 rounded-lg flex items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Activity className="w-4 h-4 text-sky-400 shrink-0" />
                    <div>
                      <div className="font-mono font-medium text-neutral-200 truncate">
                        {srcId}
                      </div>
                      <div className="text-[11px] text-neutral-500 font-mono">
                        Stage: {batchData.stage || "processing"}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleRetry(srcId)}
                      disabled={retryingSource === srcId || batchData.stage === "exporting"}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 text-neutral-300 font-mono text-[11px] disabled:opacity-50"
                      title="Retry processing for this document"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>{retryingSource === srcId ? "Retrying..." : "Retry"}</span>
                    </button>

                    <Link
                      to={`/dashboard?source_id=${srcId}`}
                      className="inline-flex items-center gap-1 px-3 py-1 rounded bg-sky-600/30 hover:bg-sky-600/40 border border-sky-500/40 text-sky-200 font-medium text-[11px]"
                    >
                      <span>Inspect</span>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};