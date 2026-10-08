import React, { useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  RotateCcw,
  ArrowRight,
  AlertCircle,
  Download,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  Play,
} from "lucide-react";
import { analyzeBatch, archiveBatch, deleteBatch, getBatch, listBatchSummaries, retryBatchSource } from "../api/batches";
import { getCaseAnalysis } from "../api/caseAnalysis";
import { AnalysisResult, SectionTitle } from "../components/caseAnalysis/AnalysisResult";
import { CaseAnalysisPage } from "./CaseAnalysisPage";
import { getSourceDocument } from "../api/sources";
import { getApiUrl } from "../api/client";
import { useConfig } from "../context/ConfigContext";
import { BackendNotConnected } from "../components/common/BackendNotConnected";
import { ErrorAlert } from "../components/common/ErrorAlert";
import { Skeleton } from "../components/common/LoadingSkeleton";
import { ConfidenceIndicator } from "../components/common/ConfidenceIndicator";
import { formatBackendDate } from "../lib/formatters";
import { NotConnectedError } from "../api/errors";
import type { BatchSummary, BatchSourceState, BatchSummaryRow } from "../types/api";
import type { Block, TableBlock, FigureBlock, PageUnit } from "../types/canonical";

const FINAL = new Set(["completed", "failed"]);
const ANALYSIS_ACTIVE = new Set(["pending", "running"]);

/** A batch still changes while its documents are parsed or its cross-document reasoning runs. */
const isActive = (b: BatchSummary | undefined) =>
  !!b && (!FINAL.has(b.status) || ANALYSIS_ACTIVE.has(b.analysis?.status ?? ""));
const PREVIEW_TABLE_ROWS = 12;

/* ------------------------------------------------------------------------------------------ page */

export const BatchProgressPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const batchId = searchParams.get("id") || "";
  const jobId = searchParams.get("job_id") || "";
  if (batchId) return <SingleBatchView batchId={batchId} jobId={jobId} />;

  const analysisView = searchParams.get("view") === "case-analysis";
  return (
    <div className="mx-auto max-w-[1600px] pt-5">
      <div className="mb-5 ml-8 inline-flex rounded-lg border border-neutral-800 bg-neutral-900/70 p-1" role="tablist" aria-label="Pipeline workspace">
        <button
          type="button"
          role="tab"
          aria-selected={!analysisView}
          onClick={() => setSearchParams({})}
          className={`rounded-md px-3 py-2 text-xs font-medium ${!analysisView ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`}
        >
          Batch Pipeline
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={analysisView}
          onClick={() => setSearchParams({ view: "case-analysis" })}
          className={`rounded-md px-3 py-2 text-xs font-medium ${analysisView ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`}
        >
          Case Analysis
        </button>
      </div>
      {analysisView ? <CaseAnalysisPage /> : <AllBatchesView />}
    </div>
  );
};

/** No batch id: one summary row per batch (searchable, paged, collapsed). Detail loads only when a row is opened. */
const AllBatchesView: React.FC = () => {
  const { config, isNotConnected: configNotConnected } = useConfig();
  const pollInterval = config?.poll_interval_ms || 2000;
  const pageSize = config?.ui?.batch_page_size;
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["batchSummaries", q, page, pageSize, showArchived],
    queryFn: ({ signal }) =>
      listBatchSummaries({ q, offset: page * (pageSize || 0), limit: pageSize, includeArchived: showArchived }, signal),
    enabled: !configNotConnected,
    retry: (count, err) => !(err instanceof NotConnectedError && err.status === 404) && count < 2,
    refetchInterval: (query) => {
      if (query.state.status === "error") return false;
      const rows = query.state.data?.batches ?? [];
      return rows.some((r) => !FINAL.has(r.status) || ANALYSIS_ACTIVE.has(r.analysis_status)) ? pollInterval : false;
    },
  });
  const rows = data?.batches ?? [];
  const limit = data?.limit || 1;
  const total = data?.total ?? 0;

  return (
    <div className="p-8 max-w-[1600px] mx-auto space-y-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-neutral-100">Batch Pipeline</h1>
          <div className="text-neutral-500 mt-1">One row per run. Open a row to see each document's parse, the final parse and the cross-document reasoning.</div>
        </div>
        <Link to="/" className="inline-flex items-center gap-1.5 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg font-medium">
          New run
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0); }}
          placeholder="Search batch id or file name"
          className="w-72 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-200"
          aria-label="Search batches"
        />
        <label className="inline-flex items-center gap-1.5 text-neutral-400">
          <input type="checkbox" checked={showArchived} onChange={(e) => { setShowArchived(e.target.checked); setPage(0); }} /> show archived
        </label>
        <span className="ml-auto text-neutral-500">{total} batch{total === 1 ? "" : "es"}</span>
      </div>

      {isLoading && <Skeleton className="h-40 w-full rounded-xl" />}
      {isError && (
        <>
          <BackendNotConnected endpoint="/batches/summary" onRetry={() => refetch()} message="Could not load batches from the backend." />
          <ErrorAlert error={error as Error} />
        </>
      )}
      {data && rows.length === 0 && (
        <div className="p-6 bg-neutral-900/60 border border-neutral-800 rounded-xl text-center text-neutral-400">
          {q ? `No batch matches "${q}".` : "No pipeline runs yet. Upload documents and start the pipeline from the Ingestion page."}
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-neutral-800">
          <table className="w-full text-left">
            <thead className="bg-neutral-900/80 text-[11px] text-neutral-500">
              <tr>
                <th className="w-8" /><th className="px-3 py-2">Batch</th><th className="px-3 py-2">Time</th><th className="px-3 py-2">Documents</th>
                <th className="px-3 py-2">Status</th><th className="px-3 py-2">Score</th><th className="px-3 py-2">Warnings</th>
                <th className="px-3 py-2">Export</th><th className="px-3 py-2">Reasoning</th><th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <BatchRow key={r.batch_id} row={r} open={!!open[r.batch_id]}
                          onToggle={() => setOpen((o) => ({ ...o, [r.batch_id]: !o[r.batch_id] }))} onChanged={() => refetch()} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > limit && (
        <div className="flex items-center justify-end gap-2 text-neutral-400">
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}
                  className="rounded border border-neutral-700 px-2 py-1 disabled:opacity-40">Previous</button>
          <span>{page * limit + 1}–{Math.min(total, (page + 1) * limit)} of {total}</span>
          <button type="button" disabled={(page + 1) * limit >= total} onClick={() => setPage((p) => p + 1)}
                  className="rounded border border-neutral-700 px-2 py-1 disabled:opacity-40">Next</button>
        </div>
      )}
    </div>
  );
};

const BatchRow: React.FC<{ row: BatchSummaryRow; open: boolean; onToggle: () => void; onChanged: () => void }> = ({ row, open, onToggle, onChanged }) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try { await fn(); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); setConfirmDelete(false); }
  };
  return (
    <>
      <tr className={`border-t border-neutral-800 align-top ${row.archived ? "opacity-60" : ""}`}>
        <td className="px-2 py-2">
          <button type="button" onClick={onToggle} aria-expanded={open} aria-label={open ? "Collapse batch" : "Expand batch"}
                  className="rounded p-1 text-neutral-400 hover:bg-neutral-800">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </td>
        <td className="px-3 py-2 font-mono text-neutral-200"><Link to={`/batch?id=${row.batch_id}`} className="hover:text-sky-300">{row.batch_id}</Link></td>
        <td className="px-3 py-2 text-neutral-400">{formatBackendDate(row.created_at)}</td>
        <td className="px-3 py-2 text-neutral-300" title={row.documents.map((d) => d.filename).join("\n")}>
          {row.document_count} · <span className="text-neutral-500">{row.documents.slice(0, 2).map((d) => d.filename).join(", ")}{row.document_count > 2 ? "…" : ""}</span>
          {row.unread_pages > 0 && <span className="ml-2 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] text-rose-300">{row.unread_pages} page(s) unread</span>}
        </td>
        <td className="px-3 py-2"><StatusBadge status={row.status} /></td>
        <td className="px-3 py-2 font-mono">{row.score == null ? <span className="text-neutral-500">—</span> : <ConfidenceIndicator confidence={row.score} size="sm" />}</td>
        <td className="px-3 py-2 font-mono text-amber-300">{row.warnings_count || <span className="text-neutral-600">0</span>}</td>
        <td className="px-3 py-2 text-[11px]" title={row.export_errors.map((e) => `${e.format}: ${e.code} ${e.reason || e.message}`).join("\n")}>
          <span className={row.export_status === "ready" ? "text-emerald-300" : row.export_status === "failed" || row.export_status === "partial" ? "text-rose-300" : "text-neutral-400"}>
            {row.export_status}
          </span>
        </td>
        <td className="px-3 py-2 text-[11px] text-neutral-300">{row.analysis_status}</td>
        <td className="px-3 py-2 text-right whitespace-nowrap">
          <button type="button" disabled={busy} onClick={() => act(() => archiveBatch(row.batch_id, !row.archived))}
                  className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800">
            {row.archived ? "Unarchive" : "Archive"}
          </button>{" "}
          {confirmDelete ? (
            <>
              <button type="button" disabled={busy} onClick={() => act(() => deleteBatch(row.batch_id))}
                      className="rounded border border-rose-600 bg-rose-600/20 px-2 py-0.5 text-[11px] text-rose-200">Confirm delete</button>{" "}
              <button type="button" onClick={() => setConfirmDelete(false)} className="text-[11px] text-neutral-400 underline">cancel</button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)}
                    className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-rose-300 hover:bg-neutral-800">Delete</button>
          )}
          {err && <div className="text-[10px] text-rose-300">{err}</div>}
        </td>
      </tr>
      {open && (
        <tr className="border-t border-neutral-800">
          <td colSpan={10} className="bg-neutral-950/40 p-3"><BatchDetail batchId={row.batch_id} onChanged={onChanged} /></td>
        </tr>
      )}
    </>
  );
};

/** Full batch detail, fetched only when its row is opened. */
const BatchDetail: React.FC<{ batchId: string; onChanged: () => void }> = ({ batchId, onChanged }) => {
  const { config } = useConfig();
  const pollInterval = config?.poll_interval_ms || 2000;
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["batchStatus", batchId],
    queryFn: ({ signal }) => getBatch(batchId, signal),
    refetchInterval: (query) => (query.state.status === "error" ? false : isActive(query.state.data) ? pollInterval : false),
  });
  if (isLoading) return <Skeleton className="h-40 w-full rounded-lg" />;
  if (isError) return <ErrorAlert error={error as Error} />;
  return data ? <BatchPanel batch={data} onChanged={() => { refetch(); onChanged(); }} /> : null;
};

/** /batch?id=… : one batch, polled until it finishes. */
const SingleBatchView: React.FC<{ batchId: string; jobId: string }> = ({ batchId, jobId }) => {
  const { config, isNotConnected: configNotConnected } = useConfig();
  const pollInterval = config?.poll_interval_ms || 2000;

  const { data: batch, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["batchStatus", batchId],
    queryFn: ({ signal }) => getBatch(batchId, signal),
    enabled: !configNotConnected,
    // A 404 means the batch does not exist: asking again will not change that.
    retry: (count, err) => !(err instanceof NotConnectedError && err.status === 404) && count < 2,
    refetchInterval: (query) => {
      if (query.state.status === "error") return false;
      return isActive(query.state.data) ? pollInterval : false;
    },
  });

  if (isError && error instanceof NotConnectedError && error.status === 404) {
    return (
      <div className="p-8 max-w-4xl mx-auto space-y-4 text-xs">
        <h1 className="text-xl font-bold text-neutral-100">Batch Pipeline</h1>
        <div className="p-6 bg-neutral-900/60 border border-neutral-800 rounded-xl text-center text-neutral-400 space-y-4">
          <p>
            Batch <span className="font-mono text-neutral-300">{batchId}</span> was not found on the backend (for example
            after the data folder was cleared).
          </p>
          <div className="flex justify-center gap-2">
            <Link to="/batch" className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-lg font-medium">
              All batches
            </Link>
            <Link to="/" className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg font-medium">
              Start a new run
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-8 max-w-4xl mx-auto space-y-4">
        <h1 className="text-xl font-bold text-neutral-100">Batch Pipeline</h1>
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
    <div className="p-8 max-w-[1600px] mx-auto space-y-6 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-neutral-100">Pipeline Execution</h1>
          <div className="text-neutral-500 font-mono text-[11px] mt-1">Job reference: {jobId || batch?.job_id || "auto-managed"}</div>
        </div>
        <Link to="/batch" className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-lg font-medium">
          All batches
        </Link>
      </div>
      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      )}
      {batch && <BatchPanel batch={batch} onChanged={() => refetch()} />}
    </div>
  );
};

/* ------------------------------------------------------------------------------------------ batch */

const statusTone = (status: string) =>
  status === "completed"
    ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/30"
    : status === "failed"
      ? "text-rose-300 bg-rose-500/10 border-rose-500/30"
      : status === "interrupted"
        ? "text-amber-300 bg-amber-500/10 border-amber-500/30"
        : "text-sky-300 bg-sky-500/10 border-sky-500/30";

const StatusBadge: React.FC<{ status: string }> = ({ status }) => (
  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border font-mono uppercase text-[10px] ${statusTone(status)}`}>
    {!FINAL.has(status) && status !== "interrupted" && <Loader2 className="w-3 h-3 animate-spin" />}
    {status}
  </span>
);

const BatchPanel: React.FC<{ batch: BatchSummary; onChanged: () => void; collapsible?: boolean }> = ({
  batch,
  onChanged,
  collapsible = false,
}) => {
  const [open, setOpen] = useState(true);
  const sources: BatchSourceState[] =
    batch.sources ?? batch.source_ids.map((id) => ({ source_id: id, status: batch.status, stage: batch.stage }));

  return (
    <section className="bg-neutral-900/60 border border-neutral-800 rounded-xl overflow-hidden" aria-label={`Batch ${batch.batch_id}`}>
      {/* Header */}
      <div className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {collapsible && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="p-1 rounded hover:bg-neutral-800 text-neutral-400"
                aria-expanded={open}
                aria-label={open ? "Collapse batch" : "Expand batch"}
              >
                {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            )}
            <Link to={`/batch?id=${batch.batch_id}`} className="font-mono text-neutral-200 hover:text-sky-300 truncate">
              {batch.batch_id}
            </Link>
            <StatusBadge status={batch.status} />
            {batch.stage && batch.stage !== batch.status && (
              <span className="text-neutral-500 font-mono text-[11px]">({batch.stage})</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-neutral-500 font-mono text-[11px]">
            <span>{formatBackendDate(batch.created_at)}</span>
            {batch.status === "completed" && (
              <Link
                to={`/dashboard?source_id=${sources.find((s) => s.status === "completed")?.source_id ?? ""}`}
                className="inline-flex items-center gap-1 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-sans font-medium"
              >
                Dashboard <ArrowRight className="w-3 h-3" />
              </Link>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1 bg-neutral-950 rounded-full h-2 overflow-hidden border border-neutral-800">
            <div className="bg-sky-500 h-full transition-all duration-300" style={{ width: `${batch.progress_percent ?? 0}%` }} />
          </div>
          <span className="font-mono text-neutral-300 tabular-nums w-10 text-right">{batch.progress_percent ?? 0}%</span>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono text-neutral-400">
          {batch.sources_summary && (
            <>
              <span>Documents: {batch.sources_summary.total}</span>
              <span className="text-emerald-400">Completed: {batch.sources_summary.completed}</span>
              <span className="text-rose-400">Failed: {batch.sources_summary.failed}</span>
            </>
          )}
          {batch.case_id && <span>Case: {batch.case_id}</span>}
          {batch.output_formats && batch.output_formats.length > 0 && <span>Formats: {batch.output_formats.join(", ")}</span>}
        </div>

        {batch.notices && batch.notices.length > 0 && (
          <ul className="space-y-0.5 text-[11px] text-sky-200">
            {batch.notices.map((n, i) => <li key={i}><span className="font-mono text-sky-300">{n.code}</span> {n.message}</li>)}
          </ul>
        )}
        {(batch.exports?.length || batch.export_errors?.length || batch.stage === "exporting") && (
          <div className="space-y-2">
            {batch.stage === "exporting" && <div className="text-neutral-500">Generating downloads…</div>}
            {batch.exports && batch.exports.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {batch.exports.map((output) => (
                  <a
                    key={output.export_id}
                    href={getApiUrl(output.download_url)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-200"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{output.format.toUpperCase()}</span>
                  </a>
                ))}
              </div>
            )}
            {batch.export_errors && batch.export_errors.length > 0 && (
              <ul className="space-y-1 text-rose-300" role="alert">
                {batch.export_errors.map((failure) => (
                  <li key={`${failure.format}:${failure.code}`}>
                    {failure.format.toUpperCase()} export failed: <span className="font-mono">{failure.code}</span>{" "}
                    {(failure as { reason?: string }).reason || failure.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Stage 1: parsing output of each document (partial outputs) */}
      {open && (
        <div className="border-t border-neutral-800 p-4 space-y-3">
          <SectionTitle n={1} title={`Parsing output per document (${sources.length})`} agents="01–04, 08" status={parsingStatus(sources)} />
          <p className="text-[11px] text-neutral-500">
            Every document is parsed in parallel. Each column is one parsed page; the columns of a document are grouped under its summary. Scroll sideways to see them all.
          </p>
          {/* Independent columns side by side: document groups, and inside each, one column per parsed page. */}
          <div className="flex items-start gap-4 overflow-x-auto pb-3">
            {sources.map((s) => (
              <SourceParseCard key={s.source_id} batchId={batch.batch_id} batchStage={batch.stage} source={s} onChanged={onChanged} />
            ))}
          </div>
        </div>
      )}

      {/* Stages 2-4: facts -> cross-document reasoning -> final output */}
      {open && <CrossDocumentSection batch={batch} onChanged={onChanged} />}
    </section>
  );
};

/* ------------------------------------------------------------------------------------------ document */

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

const Stat: React.FC<{ label: string; value: React.ReactNode; hint?: string }> = ({ label, value, hint }) => (
  <div className="min-w-0 px-2.5 py-2 bg-neutral-900 border border-neutral-800 rounded-lg" title={hint ?? label}>
    <div className="truncate text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
    <div className="font-mono text-neutral-100 text-sm tabular-nums">{value}</div>
  </div>
);

const SourceParseCard: React.FC<{
  batchId: string;
  batchStage?: string;
  source: BatchSourceState;
  onChanged: () => void;
}> = ({ batchId, batchStage, source, onChanged }) => {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const p = source.parse;
  const canRetry = source.status === "failed" || source.status === "interrupted" || source.status === "completed";

  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await retryBatchSource(batchId, source.source_id);
      onChanged();
    } catch (e) {
      setRetryError((e as Error).message);
    } finally {
      setRetrying(false);
    }
  };

  const warnings = useMemo(() => {
    const seen = new Set<string>();
    return (p?.warnings ?? []).filter((w) => {
      const k = `${w.code}:${w.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [p?.warnings]);

  return (
    <div
      className="shrink-0 p-3 bg-neutral-950/80 border border-neutral-800 rounded-xl space-y-3"
      // As wide as its page columns (300px each, 8px apart), so documents sit side by side as independent columns.
      style={{ width: Math.max(1, p?.pages ?? 1) * 308 - 8 + 26 }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 text-sky-400 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium text-neutral-200 truncate">{source.filename || source.source_id}</div>
            <div className="text-[11px] text-neutral-500 font-mono truncate">
              {source.source_id}
              {source.stage && source.stage !== source.status ? ` · ${source.stage}` : ""}
              {p?.route ? ` · route: ${p.route}` : ""}
            </div>
          </div>
          <StatusBadge status={source.status} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canRetry && (
            <button
              type="button"
              onClick={retry}
              disabled={retrying || batchStage === "exporting"}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 text-neutral-300 font-mono text-[11px] disabled:opacity-50"
              title="Process this document again"
            >
              <RotateCcw className="w-3 h-3" />
              {retrying ? "Retrying…" : "Retry"}
            </button>
          )}
          {source.status === "completed" && (
            <Link
              to={`/dashboard?source_id=${source.source_id}`}
              className="inline-flex items-center gap-1 px-3 py-1 rounded bg-sky-600/30 hover:bg-sky-600/40 border border-sky-500/40 text-sky-200 font-medium text-[11px]"
            >
              Inspect <ArrowRight className="w-3 h-3" />
            </Link>
          )}
        </div>
      </div>

      {source.error && (
        <div className="flex items-start gap-2 p-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-200" role="alert">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            <span className="font-mono">{source.error.code}</span>: {source.error.message}
          </span>
        </div>
      )}
      {retryError && <div className="text-rose-300">{retryError}</div>}

      {p && (
        <>
          <div className="grid grid-cols-4 gap-2">
            <Stat label="Pages" value={p.pages} />
            <Stat label="Blocks" value={p.blocks} />
            <Stat label="Tables" value={p.tables} />
            <Stat label="Figures" value={p.figures} />
            <Stat
              label="Score"
              value={pct(p.parse_score ? p.parse_score.value : p.document_confidence)}
              hint={p.parse_score?.formula ?? "Mean confidence of all extracted blocks"}
            />
            <Stat label="OCR agree" value={pct(p.ocr_agreement_mean)} hint="Mean agreement between the text layer and an independent OCR read" />
            <Stat label="Order" value={pct(p.reading_order_confidence)} hint="Mean reading-order confidence of the pages" />
            <Stat
              label="Review"
              value={<span className={p.needs_review ? "text-amber-300" : "text-emerald-300"}>{p.needs_review}</span>}
            />
          </div>

          <div className="flex flex-wrap gap-1.5 text-[10px] font-mono">
            {Object.entries(p.blocks_by_type).map(([t, n]) => (
              <span key={`t:${t}`} className="px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-300">
                {t} × {n}
              </span>
            ))}
            {Object.entries(p.blocks_by_method).map(([m, n]) => (
              <span key={`m:${m}`} className="px-1.5 py-0.5 rounded bg-sky-900/40 text-sky-200 border border-sky-800/50">
                {m} × {n}
              </span>
            ))}
          </div>

          {p.parse_score?.cap?.applied && (
            <div className="px-2 py-1 rounded border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-200">
              Score capped at {p.parse_score.cap.max} because {p.parse_score.cap.reason}.
            </div>
          )}
          {warnings.length > 0 && <WarningsList warnings={warnings} />}
        </>
      )}

      {!p && !FINAL.has(source.status) && source.status !== "interrupted" && (
        <div className="flex items-center gap-2 text-neutral-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Waiting for the first parsed pages…
        </div>
      )}

      {source.status === "completed" && p && p.blocks > 0 && (
        <PageColumns sourceId={source.source_id} version={`${p.blocks}:${p.document_confidence}`} />
      )}
    </div>
  );
};

const WarningsList: React.FC<{ warnings: { code: string; message: string }[] }> = ({ warnings }) => {
  const [all, setAll] = useState(false);
  const shown = all ? warnings : warnings.slice(0, 3);
  return (
    <ul className="space-y-1 text-amber-200/90">
      {shown.map((w) => (
        <li key={`${w.code}:${w.message}`} className="flex items-start gap-1.5">
          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>
            <span className="font-mono text-amber-300">{w.code}</span> {w.message}
          </span>
        </li>
      ))}
      {warnings.length > 3 && (
        <li>
          <button type="button" className="text-neutral-400 hover:text-neutral-200 underline" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer warnings" : `Show all ${warnings.length} warnings`}
          </button>
        </li>
      )}
    </ul>
  );
};

/* ------------------------------------------------------------------------------------------ extracted content */

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const PAGE_STATUS_STYLE: Record<string, string> = {
  ok: "text-emerald-300", partial: "text-amber-300", needs_ocr: "text-rose-300", unreadable: "text-rose-300", blank: "text-neutral-500",
};
const PAGE_STATUS_TEXT: Record<string, string> = {
  ok: "read", partial: "partly read", needs_ocr: "page unread: needs OCR", unreadable: "page unread", blank: "blank page",
};

type Row = { kind: "block"; block: Block } | { kind: "shreds"; blocks: Block[] };

/** Consecutive tiny text fragments (single characters etc.) are grouped into one expandable row. */
function groupShreds(blocks: Block[], maxChars: number, minRun: number): Row[] {
  const rows: Row[] = [];
  let run: Block[] = [];
  const flush = () => {
    if (run.length >= minRun) rows.push({ kind: "shreds", blocks: run });
    else run.forEach((b) => rows.push({ kind: "block", block: b }));
    run = [];
  };
  for (const b of blocks) {
    if (b.type === "text" && (b.raw_text ?? "").trim().length <= maxChars) run.push(b);
    else { flush(); rows.push({ kind: "block", block: b }); }
  }
  flush();
  return rows;
}

/** Renders rows in chunks; the next chunk is added when the end of the list scrolls into view. */
const ChunkedList: React.FC<{ rows: Row[]; chunk: number; render: (r: Row) => React.ReactNode }> = ({ rows, chunk, render }) => {
  const [n, setN] = useState(chunk);
  const sentinel = React.useRef<HTMLLIElement | null>(null);
  React.useEffect(() => {
    const el = sentinel.current;
    if (!el || n >= rows.length || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setN((x) => x + chunk); });
    io.observe(el);
    return () => io.disconnect();
  }, [n, rows.length, chunk]);
  return (
    <>
      {rows.slice(0, n).map(render)}
      {n < rows.length && (
        <li ref={sentinel} className="px-3 py-2 text-center">
          <button type="button" onClick={() => setN((x) => x + chunk)} className="text-[10px] text-sky-300 underline">
            {rows.length - n} more
          </button>
        </li>
      )}
    </>
  );
};

const ShredRow: React.FC<{ blocks: Block[] }> = ({ blocks }) => {
  const [open, setOpen] = useState(false);
  return (
    <li className="px-3 py-2 space-y-1">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-left text-[11px] text-amber-200">
        {blocks.length} short fragments: <span className="font-mono">{blocks.map((b) => b.raw_text).join(" ").slice(0, 80)}</span>
      </button>
      {open && <ul className="pl-3 font-mono text-[10px] text-neutral-400">{blocks.map((b) => <li key={b.block_id}>{b.raw_text} · {Math.round(b.confidence * 100)}%</li>)}</ul>}
    </li>
  );
};

/** One independent column per parsed page, side by side. */
const PageColumns: React.FC<{ sourceId: string; version: string }> = ({ sourceId, version }) => {
  const { config } = useConfig();
  const chunk = config?.ui?.block_render_chunk || 40;
  const maxChars = config?.ui?.shred_max_chars ?? 2;
  const minRun = config?.ui?.shred_min_run ?? 3;
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["batchSourceDocument", sourceId, version],
    queryFn: ({ signal }) => getSourceDocument(sourceId, signal),
    staleTime: Infinity,
  });

  if (isLoading) return <Skeleton className="h-64 w-[300px] rounded-lg" />;
  if (isError) return <ErrorAlert error={error as Error} />;
  const pages: PageUnit[] = data?.pages ?? [];
  if (!pages.length) return null;

  return (
    <div className="flex items-stretch gap-2">
      {pages.map((pg) => {
        const blocks = [...pg.blocks].sort((a, b) => (a.reading_order_index ?? 0) - (b.reading_order_index ?? 0));
        const review = blocks.filter((b) => b.needs_review).length;
        const status = pg.status || "ok";
        const unread = status === "needs_ocr" || status === "unreadable";
        const score = pg.page_score?.value;
        return (
          <div key={pg.page_id} className={`w-[300px] shrink-0 flex flex-col rounded-lg bg-neutral-900/40 overflow-hidden border ${unread ? "border-rose-500/60" : "border-neutral-800"}`}>
            <div className={`px-3 py-2 border-b space-y-1 ${unread ? "bg-rose-500/10 border-rose-500/40" : "bg-neutral-900 border-neutral-800"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-neutral-100">Page {pg.page_number}</span>
                {score == null ? <span className="text-[10px] text-neutral-500">not scored</span> : (
                  <span title={`${pg.page_score?.formula ?? ""}${pg.page_score?.cap_reason ? ` · capped: ${pg.page_score.cap_reason}` : ""}`}>
                    <ConfidenceIndicator confidence={score} size="sm" />
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono text-neutral-500">
                <span className={PAGE_STATUS_STYLE[status] || ""}>{PAGE_STATUS_TEXT[status] || status}</span>
                <span>{pg.layout_class}</span>
                <span>{blocks.length} blocks</span>
                <span>order {pct(pg.reading_order_confidence)}</span>
                {pg.coverage_score != null && <span title="share of the printed page covered by extracted blocks">coverage {pct(pg.coverage_score)}</span>}
                {(pg.uncovered_regions?.length ?? 0) > 0 && <span className="text-amber-300">{pg.uncovered_regions!.length} uncovered region(s)</span>}
                {review > 0 && <span className="text-amber-300">{review} need review</span>}
              </div>
            </div>
            <ol className="flex-1 max-h-[60vh] overflow-y-auto divide-y divide-neutral-800/80">
              {unread && (
                <li className="px-3 py-3 text-[11px] text-rose-200">
                  This page has printed content but nothing was extracted
                  {status === "needs_ocr" ? " because no OCR engine is available (see the document warning)." : "."}
                </li>
              )}
              <ChunkedList
                rows={groupShreds(blocks, maxChars, minRun)}
                chunk={chunk}
                render={(r) =>
                  r.kind === "shreds" ? <ShredRow key={r.blocks[0].block_id} blocks={r.blocks} /> : (
                    <li key={r.block.block_id} className="px-3 py-2 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[10px] text-sky-300">{r.block.type}</span>
                        <ConfidenceIndicator confidence={r.block.confidence} size="sm" />
                      </div>
                      <BlockBody block={r.block} />
                      <div className="text-[10px] font-mono text-neutral-500">
                        {r.block.extraction_method}
                        {r.block.needs_review && (
                          <span className="ml-2 text-amber-300">
                            needs review{(r.block as { review_reasons?: string[] }).review_reasons?.length ? `: ${(r.block as { review_reasons?: string[] }).review_reasons!.join(", ")}` : ""}
                          </span>
                        )}
                        {(r.block.warnings ?? []).map((w) => <span key={w.code} className="ml-2 text-neutral-400">{w.code}</span>)}
                      </div>
                    </li>
                  )
                }
              />
              {blocks.length === 0 && !unread && <li className="px-3 py-2 text-neutral-500">No content on this page.</li>}
            </ol>
          </div>
        );
      })}
    </div>
  );
};

const BlockBody: React.FC<{ block: Block }> = ({ block }) => {
  if (block.locked || block.masked) return <span className="italic text-neutral-500">Restricted value</span>;

  if (block.type === "table" && "cells" in block) {
    const t = block as TableBlock;
    const rows = Math.min(t.n_rows, PREVIEW_TABLE_ROWS);
    const grid: (string | null)[][] = Array.from({ length: rows }, () => Array(t.n_cols).fill(null));
    const header: boolean[] = Array(rows).fill(false);
    for (const c of t.cells) {
      if (c.row < rows && c.col < t.n_cols) {
        grid[c.row][c.col] = c.raw_text;
        if (c.is_header) header[c.row] = true;
      }
    }
    return (
      <div className="overflow-x-auto">
        {t.caption && <div className="text-neutral-400 mb-1">{t.caption}</div>}
        <table className="border-collapse text-[11px]">
          <tbody>
            {grid.map((r, i) => (
              <tr key={i} className={header[i] ? "bg-neutral-800/60 font-semibold" : ""}>
                {r.map((cell, j) => (
                  <td key={j} className="border border-neutral-800 px-2 py-0.5 text-neutral-200 whitespace-nowrap">
                    {cell ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {t.n_rows > rows && <div className="text-neutral-500 mt-1">+ {t.n_rows - rows} more rows</div>}
      </div>
    );
  }

  if ((block.type === "figure" || block.type === "chart") && "crop_url" in block) {
    const f = block as FigureBlock & { text_inside?: string | null; interpreted?: boolean; title?: string | null; labels?: { text: string }[] };
    const src = f.crop_url?.startsWith("http") ? f.crop_url : f.crop_url ? getApiUrl(f.crop_url) : "";
    return (
      <div className="space-y-1">
        {src && <img src={src} alt={f.caption || block.type} loading="lazy" className="max-h-32 rounded border border-neutral-800" />}
        <div className="text-neutral-300">{f.caption || f.title || <span className="text-neutral-500">no caption found</span>}</div>
        {f.text_inside && <div className="text-[10px] text-neutral-400">text inside: {f.text_inside}</div>}
        {f.labels && f.labels.length > 0 && <div className="text-[10px] text-neutral-400">labels: {f.labels.map((l) => l.text).join(" · ")}</div>}
        {f.interpreted === false && (
          <div className="text-[10px] text-amber-300/80">
            {block.type === "chart" ? "chart detected; data series not digitised" : "image content not interpreted"}
          </div>
        )}
      </div>
    );
  }

  if (block.type === "equation") {
    const e = block as Block & { latex?: string | null; latex_unavailable_reason?: string; fragments?: string[] };
    return (
      <div className="space-y-0.5">
        <pre className="whitespace-pre-wrap rounded bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100">{e.raw_text}</pre>
        <div className="text-[10px] text-neutral-500">
          {e.fragments ? `${e.fragments.length} fragment(s) merged · ` : ""}{e.latex ? `LaTeX: ${e.latex}` : e.latex_unavailable_reason || "no LaTeX"}
        </div>
      </div>
    );
  }

  const text = block.raw_text ?? block.raw_value ?? "";
  return <div className="text-neutral-200 whitespace-pre-wrap break-words">{text || <span className="text-neutral-500">(empty)</span>}</div>;
};

/* ------------------------------------------------------------------------------------------ cross-document reasoning */

function parsingStatus(sources: BatchSourceState[]): string | undefined {
  if (sources.some((s) => !FINAL.has(s.status) && s.status !== "interrupted")) return undefined;
  return sources.some((s) => s.status !== "completed") ? "failed" : "completed";
}

const CrossDocumentSection: React.FC<{ batch: BatchSummary; onChanged: () => void }> = ({ batch, onChanged }) => {
  const state = batch.analysis ?? { status: "not_run" };
  const caseId = state.case_id || batch.case_id || "";
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const done = state.status === "completed" || (state.status === "failed" && !!state.analyzed_at);
  const analysisQ = useQuery({
    queryKey: ["batchCaseAnalysis", caseId, state.analyzed_at],
    queryFn: ({ signal }) => getCaseAnalysis(caseId, signal),
    enabled: done && Boolean(caseId),
    staleTime: Infinity,
  });

  const run = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await analyzeBatch(batch.batch_id);
      onChanged();
    } catch (e) {
      setStartError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  // Never leave a finished batch without reasoning: start it automatically once.
  const autoStarted = React.useRef(false);
  React.useEffect(() => {
    if (state.status === "not_run" && FINAL.has(batch.status) && !autoStarted.current) {
      autoStarted.current = true;
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, batch.status]);

  const runButton = (label: string) => (
    <button
      type="button"
      onClick={run}
      disabled={starting}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium disabled:opacity-50"
    >
      <Play className="w-3 h-3" /> {starting ? "Starting…" : label}
    </button>
  );

  return (
    <div className="border-t border-neutral-800 p-4 space-y-4">
      {!done && (
        <SectionTitle n={2} title="Final parse, facts and cross-document reasoning" agents="15, 16" status={state.status === "failed" ? "failed" : undefined} />
      )}

      {state.status === "pending" && (
        <div className="flex items-center gap-2 text-neutral-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Waiting for every document to finish parsing. Facts are then normalized and compared across the documents automatically.
        </div>
      )}
      {state.status === "running" && (
        <div className="flex items-center gap-2 text-sky-300">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Normalizing facts (agent 15) and comparing them across documents (agent 16)…
        </div>
      )}
      {state.status === "skipped" && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-neutral-900 border border-neutral-800 text-neutral-400">
          <span>{state.reason}</span>
          {batch.case_id && runButton("Run again")}
        </div>
      )}
      {state.status === "not_run" && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-neutral-900 border border-neutral-800 text-neutral-400">
          <span>Starting fact normalization and cross-document reasoning…</span>
          {runButton("Run cross-document reasoning")}
        </div>
      )}
      {state.status === "failed" && !state.analyzed_at && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-200" role="alert">
          <span>
            {state.error?.code && <span className="font-mono">{state.error.code}: </span>}
            {state.error?.message ?? "Cross-document reasoning failed."}
          </span>
          {runButton("Run again")}
        </div>
      )}
      {startError && <div className="text-rose-300">{startError}</div>}

      {done && analysisQ.isLoading && <Skeleton className="h-40 w-full rounded-lg" />}
      {done && analysisQ.isError && <ErrorAlert error={analysisQ.error as Error} />}
      {done && analysisQ.data && (
        <>
          <AnalysisResult analysis={analysisQ.data} finalPosition="bottom" showParsing={false} firstStage={2} />
          <div className="flex flex-wrap items-center justify-end gap-2 text-[11px] text-neutral-500">
            {caseId && (
              <Link to={`/case-analysis?case_id=${caseId}`} className="text-sky-300 hover:underline">
                Open in Case Analysis
              </Link>
            )}
            {runButton("Re-run reasoning")}
          </div>
        </>
      )}
    </div>
  );
};