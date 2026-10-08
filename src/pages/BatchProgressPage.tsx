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
import { analyzeBatch, getBatch, listBatches, retryBatchSource } from "../api/batches";
import { getCaseAnalysis } from "../api/caseAnalysis";
import { AnalysisResult, SectionTitle } from "../components/caseAnalysis/AnalysisResult";
import { getSourceDocument } from "../api/sources";
import { getApiUrl } from "../api/client";
import { useConfig } from "../context/ConfigContext";
import { BackendNotConnected } from "../components/common/BackendNotConnected";
import { ErrorAlert } from "../components/common/ErrorAlert";
import { Skeleton } from "../components/common/LoadingSkeleton";
import { ConfidenceIndicator } from "../components/common/ConfidenceIndicator";
import { formatBackendDate } from "../lib/formatters";
import { NotConnectedError } from "../api/errors";
import type { BatchSummary, BatchSourceState } from "../types/api";
import type { Block, TableBlock, FigureBlock } from "../types/canonical";

const FINAL = new Set(["completed", "failed"]);
const ANALYSIS_ACTIVE = new Set(["pending", "running"]);

/** A batch still changes while its documents are parsed or its cross-document reasoning runs. */
const isActive = (b: BatchSummary | undefined) =>
  !!b && (!FINAL.has(b.status) || ANALYSIS_ACTIVE.has(b.analysis?.status ?? ""));
const PREVIEW_TABLE_ROWS = 12;

/* ------------------------------------------------------------------------------------------ page */

export const BatchProgressPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const batchId = searchParams.get("id") || "";
  const jobId = searchParams.get("job_id") || "";
  return batchId ? <SingleBatchView batchId={batchId} jobId={jobId} /> : <AllBatchesView />;
};

/** No batch id: every batch on the backend, newest first, each with the parsing output of its documents. */
const AllBatchesView: React.FC = () => {
  const { config, isNotConnected: configNotConnected } = useConfig();
  const pollInterval = config?.poll_interval_ms || 2000;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["batches"],
    queryFn: ({ signal }) => listBatches(signal),
    enabled: !configNotConnected,
    retry: (count, err) => !(err instanceof NotConnectedError && err.status === 404) && count < 2,
    refetchInterval: (query) => {
      if (query.state.status === "error") return false;
      const batches = query.state.data?.batches ?? [];
      return batches.some(isActive) ? pollInterval : false;
    },
  });

  const batches = data?.batches ?? [];

  return (
    <div className="p-8 max-w-[1600px] mx-auto space-y-6 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-neutral-100">Batch Pipeline</h1>
          <div className="text-neutral-500 mt-1">
            All pipeline runs and what parsing produced for each document. Running batches update automatically.
          </div>
        </div>
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg font-medium"
        >
          New run
        </Link>
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      )}

      {isError && (
        <>
          <BackendNotConnected endpoint="/batches" onRetry={() => refetch()} message="Could not load batches from the backend." />
          <ErrorAlert error={error as Error} />
        </>
      )}

      {data && batches.length === 0 && (
        <div className="p-6 bg-neutral-900/60 border border-neutral-800 rounded-xl text-center text-neutral-400 space-y-4">
          <p>No pipeline runs yet. Upload documents and start the pipeline from the Ingestion page.</p>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg font-medium"
          >
            Go to Ingestion
          </Link>
        </div>
      )}

      {batches.map((batch) => (
        <BatchPanel key={batch.batch_id} batch={batch} onChanged={() => refetch()} collapsible />
      ))}
    </div>
  );
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
                    {failure.format.toUpperCase()} export failed: {failure.message}
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

/** One independent column per parsed page, side by side. */
const PageColumns: React.FC<{ sourceId: string; version: string }> = ({ sourceId, version }) => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["batchSourceDocument", sourceId, version],
    queryFn: ({ signal }) => getSourceDocument(sourceId, signal),
    staleTime: Infinity,
  });

  if (isLoading) return <Skeleton className="h-64 w-[300px] rounded-lg" />;
  if (isError) return <ErrorAlert error={error as Error} />;
  const pages = data?.pages ?? [];
  if (!pages.length) return null;

  return (
    <div className="flex items-stretch gap-2">
      {pages.map((pg) => {
        const blocks = [...pg.blocks].sort((a, b) => (a.reading_order_index ?? 0) - (b.reading_order_index ?? 0));
        const conf = mean(blocks.map((b) => b.confidence));
        const review = blocks.filter((b) => b.needs_review).length;
        return (
          <div key={pg.page_id} className="w-[300px] shrink-0 flex flex-col border border-neutral-800 rounded-lg bg-neutral-900/40 overflow-hidden">
            <div className="px-3 py-2 bg-neutral-900 border-b border-neutral-800 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-neutral-100">Page {pg.page_number}</span>
                {conf !== null && <ConfidenceIndicator confidence={conf} size="sm" />}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono text-neutral-500">
                <span>{pg.layout_class}</span>
                <span>{blocks.length} blocks</span>
                <span>order {pct(pg.reading_order_confidence)}</span>
                {review > 0 && <span className="text-amber-300">{review} need review</span>}
              </div>
            </div>
            <ol className="flex-1 max-h-[60vh] overflow-y-auto divide-y divide-neutral-800/80">
              {blocks.map((block) => (
                <li key={block.block_id} className="px-3 py-2 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] text-sky-300">{block.type}</span>
                    <ConfidenceIndicator confidence={block.confidence} size="sm" />
                  </div>
                  <BlockBody block={block} />
                  <div className="text-[10px] font-mono text-neutral-500">
                    {block.extraction_method}
                    {block.needs_review && <span className="ml-2 text-amber-300">needs review</span>}
                  </div>
                </li>
              ))}
              {blocks.length === 0 && <li className="px-3 py-2 text-neutral-500">No content on this page.</li>}
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

  if (block.type === "figure" && "crop_url" in block) {
    const f = block as FigureBlock;
    const src = f.crop_url?.startsWith("http") ? f.crop_url : f.crop_url ? getApiUrl(f.crop_url) : "";
    return (
      <div className="space-y-1">
        {src && <img src={src} alt={f.caption || "Figure"} loading="lazy" className="max-h-32 rounded border border-neutral-800" />}
        {(f.caption || f.raw_text) && <div className="text-neutral-300">{f.caption || f.raw_text}</div>}
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