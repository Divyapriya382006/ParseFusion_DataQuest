import React, { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  FileText,
  Table,
  Image,
  Sigma,
  AlertTriangle,
  Code,
  Layers,
  Copy,
  Check,
  ExternalLink,
} from "lucide-react";
import { getSourceDocument, listSources } from "../api/sources";
import { BackendNotConnected } from "../components/common/BackendNotConnected";
import { SourceViewer } from "../components/viewer/SourceViewer";
import { VisualDocMap } from "../components/viewer/VisualDocMap";
import { TableRenderer } from "../components/table/TableRenderer";
import { SandboxedHtmlPreview } from "../components/common/SandboxedHtmlPreview";
import { Skeleton } from "../components/common/LoadingSkeleton";
import { formatBytes } from "../lib/formatters";
import type { TableBlock, ChartBlock, EquationBlock, FigureBlock } from "../types/canonical";

export const ResultsDashboardPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const requestedSourceId = searchParams.get("source_id") || "";

  const [activeTab, setActiveTab] = useState<string>("source_viewer");
  const [currentPageIndex, setCurrentPageIndex] = useState<number>(0);
  const [jsonCopied, setJsonCopied] = useState<boolean>(false);

  // List available sources
  const { data: sourcesListData, isError: listSourcesError, refetch: refetchList } = useQuery({
    queryKey: ["sourcesList"],
    queryFn: ({ signal }) => listSources(signal),
  });

  const activeSourceId =
    requestedSourceId ||
    sourcesListData?.sources?.[0]?.source_id ||
    "";

  // Fetch full canonical SourceDocument
  const {
    data: sourceDoc,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["sourceDocument", activeSourceId],
    queryFn: ({ signal }) => getSourceDocument(activeSourceId, signal),
    enabled: Boolean(activeSourceId),
  });

  const handleCopyJson = () => {
    if (!sourceDoc) return;
    navigator.clipboard.writeText(JSON.stringify(sourceDoc, null, 2));
    setJsonCopied(true);
    setTimeout(() => setJsonCopied(false), 2000);
  };

  if (listSourcesError || (isError && !sourceDoc)) {
    return (
      <div className="p-8 max-w-6xl mx-auto space-y-4">
        <h1 className="text-xl font-bold text-neutral-100">Results Dashboard</h1>
        <BackendNotConnected
          endpoint={activeSourceId ? `/sources/${activeSourceId}` : "/sources"}
          onRetry={() => {
            refetchList();
            if (activeSourceId) refetch();
          }}
          message="Could not retrieve canonical extracted documents from the backend."
        />
      </div>
    );
  }

  const pages = sourceDoc?.pages || [];
  const currentPage = pages[currentPageIndex] || pages[0];

  // Aggregate blocks across all pages for typed tabs
  const allBlocks = pages.flatMap((p) => p.blocks || []);
  const tableBlocks = allBlocks.filter((b): b is TableBlock => b.type === "table");
  const chartBlocks = allBlocks.filter((b): b is ChartBlock => b.type === "chart");
  const figureBlocks = allBlocks.filter((b): b is FigureBlock => b.type === "figure");
  const equationBlocks = allBlocks.filter((b): b is EquationBlock => b.type === "equation");
  const allWarnings = [
    ...(sourceDoc?.warnings || []),
    ...allBlocks.flatMap((b) => b.warnings || []),
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6 text-xs">
      {/* Header & Source Picker */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-neutral-800">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-neutral-100">Extraction Results</h1>
            {sourceDoc && (
              <span className="font-mono text-neutral-300 bg-neutral-900 border border-neutral-800 px-2.5 py-0.5 rounded text-xs">
                {sourceDoc.filename}
              </span>
            )}
          </div>
          {sourceDoc && (
            <div className="text-neutral-500 font-mono text-[11px] mt-1 flex items-center gap-3">
              <span>ID: {sourceDoc.source_id}</span>
              <span>SHA256: {sourceDoc.sha256?.substring(0, 16)}...</span>
              <span>Size: {formatBytes(sourceDoc.size_bytes)}</span>
              <span>Pages: {sourceDoc.page_count}</span>
            </div>
          )}
        </div>

        {/* Source Selector */}
        {sourcesListData?.sources && sourcesListData.sources.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-neutral-400">Document:</span>
            <select
              value={activeSourceId}
              onChange={(e) => {
                const newId = e.target.value;
                window.location.search = `?source_id=${newId}`;
              }}
              className="bg-neutral-950 border border-neutral-800 rounded px-2.5 py-1.5 text-neutral-200 text-xs"
            >
              {sourcesListData.sources.map((s) => (
                <option key={s.source_id} value={s.source_id}>
                  {s.filename || s.source_id}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-10 w-full rounded" />
          <Skeleton className="h-[600px] w-full rounded-xl" />
        </div>
      )}

      {sourceDoc && (
        <>
          {/* Navigation Tabs (tabs appear only if data exists) */}
          <div className="flex items-center gap-1 border-b border-neutral-800 overflow-x-auto pb-px">
            <button
              type="button"
              onClick={() => setActiveTab("source_viewer")}
              className={`flex items-center gap-1.5 px-4 py-2 border-b-2 font-medium text-xs whitespace-nowrap transition-colors ${
                activeTab === "source_viewer"
                  ? "border-sky-500 text-neutral-100"
                  : "border-transparent text-neutral-400 hover:text-neutral-200"
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Source Viewer</span>
            </button>

            {tableBlocks.length > 0 && (
              <button
                type="button"
                onClick={() => setActiveTab("tables")}
                className={`flex items-center gap-1.5 px-4 py-2 border-b-2 font-medium text-xs whitespace-nowrap transition-colors ${
                  activeTab === "tables"
                    ? "border-sky-500 text-neutral-100"
                    : "border-transparent text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <Table className="w-3.5 h-3.5" />
                <span>Tables ({tableBlocks.length})</span>
              </button>
            )}

            {(chartBlocks.length > 0 || figureBlocks.length > 0) && (
              <button
                type="button"
                onClick={() => setActiveTab("figures")}
                className={`flex items-center gap-1.5 px-4 py-2 border-b-2 font-medium text-xs whitespace-nowrap transition-colors ${
                  activeTab === "figures"
                    ? "border-sky-500 text-neutral-100"
                    : "border-transparent text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <Image className="w-3.5 h-3.5" />
                <span>Figures & Charts ({chartBlocks.length + figureBlocks.length})</span>
              </button>
            )}

            {equationBlocks.length > 0 && (
              <button
                type="button"
                onClick={() => setActiveTab("equations")}
                className={`flex items-center gap-1.5 px-4 py-2 border-b-2 font-medium text-xs whitespace-nowrap transition-colors ${
                  activeTab === "equations"
                    ? "border-sky-500 text-neutral-100"
                    : "border-transparent text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <Sigma className="w-3.5 h-3.5" />
                <span>Equations ({equationBlocks.length})</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setActiveTab("json")}
              className={`flex items-center gap-1.5 px-4 py-2 border-b-2 font-medium text-xs whitespace-nowrap transition-colors ${
                activeTab === "json"
                  ? "border-sky-500 text-neutral-100"
                  : "border-transparent text-neutral-400 hover:text-neutral-200"
              }`}
            >
              <Code className="w-3.5 h-3.5" />
              <span>Structured JSON</span>
            </button>

            {allWarnings.length > 0 && (
              <button
                type="button"
                onClick={() => setActiveTab("warnings")}
                className={`flex items-center gap-1.5 px-4 py-2 border-b-2 font-medium text-xs whitespace-nowrap transition-colors ${
                  activeTab === "warnings"
                    ? "border-amber-500 text-amber-300"
                    : "border-transparent text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                <span>Advisories ({allWarnings.length})</span>
              </button>
            )}
          </div>

          {/* Tab 1: Source Viewer with Side Visual Map */}
          {activeTab === "source_viewer" && (
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 h-[750px]">
              <div className="lg:col-span-1 hidden lg:block overflow-hidden">
                <VisualDocMap
                  pages={pages}
                  currentPageIndex={currentPageIndex}
                  onSelectPage={(idx) => setCurrentPageIndex(idx)}
                />
              </div>

              <div className="lg:col-span-3 h-full overflow-hidden">
                {currentPage ? (
                  <SourceViewer
                    page={currentPage}
                    totalPages={pages.length}
                    currentPageNumber={currentPage.page_number}
                    onPageChange={(pNum) => setCurrentPageIndex(pNum - 1)}
                  />
                ) : (
                  <div className="h-full flex items-center justify-center text-neutral-500 bg-neutral-950/40 rounded-xl">
                    No page units assembled for this source document.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab 2: Tables */}
          {activeTab === "tables" && (
            <div className="space-y-6">
              {tableBlocks.map((tbl) => (
                <TableRenderer key={tbl.table_id || tbl.block_id} table={tbl} />
              ))}
            </div>
          )}

          {/* Tab 3: Figures & Charts */}
          {activeTab === "figures" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[...chartBlocks, ...figureBlocks].map((fig) => (
                <div
                  key={fig.block_id}
                  className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-neutral-200 uppercase tracking-wide">
                      {fig.type} Block (#{fig.reading_order_index})
                    </span>
                    <span className="font-mono text-neutral-400 text-[11px]">
                      Conf: {Math.round(fig.confidence * 100)}%
                    </span>
                  </div>

                  <div className="w-full h-64 bg-neutral-950 border border-neutral-800 rounded-lg overflow-hidden flex items-center justify-center">
                    <img
                      src={fig.crop_url}
                      alt={
                        fig.type === "figure"
                          ? (fig as FigureBlock).caption || "Extracted figure"
                          : (fig as ChartBlock).title || "Extracted chart"
                      }
                      referrerPolicy="no-referrer"
                      className="max-w-full max-h-full object-contain"
                      loading="lazy"
                    />
                  </div>

                  {fig.type === "figure" && (fig as FigureBlock).caption && (
                    <div className="text-neutral-300 text-xs italic">
                      "{(fig as FigureBlock).caption}"
                    </div>
                  )}

                  {fig.type === "chart" && (fig as ChartBlock).title && (
                    <div className="text-neutral-300 text-xs font-medium">
                      {(fig as ChartBlock).title}
                    </div>
                  )}

                  {fig.type === "chart" && (fig as ChartBlock).insight_text && (
                    <div className="p-2.5 bg-neutral-950 rounded border border-neutral-800 text-neutral-300">
                      {(fig as ChartBlock).insight_text}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Tab 4: Equations */}
          {activeTab === "equations" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {equationBlocks.map((eq) => (
                <div
                  key={eq.equation_id || eq.block_id}
                  className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-neutral-200 uppercase tracking-wide">
                      Equation #{eq.reading_order_index}
                    </span>
                    <span className="font-mono text-neutral-400 text-[11px]">
                      {eq.verified ? "Verified Symbolic" : "Unverified"}
                    </span>
                  </div>

                  <div className="p-4 bg-neutral-950 rounded-lg border border-neutral-800 font-mono text-sky-300 text-sm overflow-x-auto text-center">
                    {eq.latex || eq.plain_text || "(No LaTeX expression)"}
                  </div>

                  {eq.crop_url && (
                    <div className="w-full h-24 bg-neutral-950 border border-neutral-800 rounded overflow-hidden flex items-center justify-center">
                      <img
                        src={eq.crop_url}
                        alt="Crop"
                        referrerPolicy="no-referrer"
                        className="max-h-full object-contain"
                        loading="lazy"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Tab 5: Structured JSON */}
          {activeTab === "json" && (
            <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-neutral-400 text-xs">
                  Canonical SourceDocument Envelope
                </span>
                <button
                  type="button"
                  onClick={handleCopyJson}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-200 transition-colors"
                >
                  {jsonCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{jsonCopied ? "Copied!" : "Copy JSON"}</span>
                </button>
              </div>

              <pre className="p-4 bg-neutral-950 rounded-lg border border-neutral-800 text-sky-200 font-mono text-xs overflow-x-auto max-h-[600px]">
                {JSON.stringify(sourceDoc, null, 2)}
              </pre>
            </div>
          )}

          {/* Tab 6: Warnings and Errors */}
          {activeTab === "warnings" && (
            <div className="space-y-3">
              {allWarnings.map((w, idx) => (
                <div
                  key={idx}
                  className="p-3 bg-neutral-950/80 border border-amber-500/20 rounded-lg flex items-start gap-3"
                >
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-mono text-amber-300 font-medium">{w.code}</div>
                    <div className="text-neutral-300 mt-0.5">{w.message}</div>
                    {(w.block_id || w.source_id) && (
                      <div className="font-mono text-[10px] text-neutral-500 mt-1">
                        Scope: {w.block_id || w.source_id}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
