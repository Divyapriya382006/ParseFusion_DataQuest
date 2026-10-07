import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileArchive, CheckCircle2, ExternalLink } from "lucide-react";
import { requestExport, fetchExportHistory } from "../agents/20_export";
import type { ExportRecord } from "../agents/20_export";
import { useConfig } from "../context/ConfigContext";
import { BackendNotConnected } from "../components/common/BackendNotConnected";
import { formatBackendDate } from "../lib/formatters";

export const ExportsPage: React.FC = () => {
  const { config, isNotConnected: configNotConnected, refetch: refetchConfig } = useConfig();

  const [scopeType, setScopeType] = useState<string>("case");
  const [scopeIds, setScopeIds] = useState<string>("");
  const [format, setFormat] = useState<string>("zip_bundle");
  const [includeEvidence, setIncludeEvidence] = useState<boolean>(true);
  const [masked, setMasked] = useState<boolean>(false);

  const [activeExport, setActiveExport] = useState<ExportRecord | null>(null);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch export history from Agent 20
  const { data: historyData, isError: historyError, refetch: refetchHistory } = useQuery({
    queryKey: ["exportHistory"],
    queryFn: ({ signal }) => fetchExportHistory(signal),
  });

  const handleCreateExport = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    const parsedIds = scopeIds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      setIsExporting(true);
      const res = await requestExport({
        scope: {
          type: scopeType,
          ids: parsedIds.length > 0 ? parsedIds : ["all"],
        },
        format,
        options: {
          masked,
          include_evidence: includeEvidence,
        },
      });
      setActiveExport(res);
      refetchHistory();
    } catch (err: unknown) {
      setErrorMsg((err as Error).message);
    } finally {
      setIsExporting(false);
    }
  };

  if (configNotConnected || historyError) {
    return (
      <div className="p-8 max-w-5xl mx-auto space-y-4">
        <h1 className="text-xl font-bold text-neutral-100">Verifiable Archive Exports</h1>
        <BackendNotConnected
          endpoint="/agents/export"
          onRetry={() => {
            refetchConfig();
            refetchHistory();
          }}
          message="Could not load export parameters or archives from the backend."
        />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 text-xs">
      <div>
        <h1 className="text-xl font-bold text-neutral-100 flex items-center gap-2">
          <Download className="w-5 h-5 text-sky-400" />
          <span>Verifiable Multi-Format Exports</span>
        </h1>
        <p className="text-xs text-neutral-400 mt-1">
          Generate tamper-evident bundles with cryptographic content hashes and signed manifests.
        </p>
      </div>

      {errorMsg && (
        <div className="p-3 bg-rose-950/30 border border-rose-800 text-rose-300 rounded-lg">
          {errorMsg}
        </div>
      )}

      {/* Export Configuration Form */}
      <form
        onSubmit={handleCreateExport}
        className="p-5 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-4"
      >
        <div className="text-[11px] font-semibold text-neutral-300 uppercase tracking-wider">
          Configure Export Package
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="text-neutral-400 font-medium block">Scope Type</label>
            <select
              value={scopeType}
              onChange={(e) => setScopeType(e.target.value)}
              className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-neutral-200"
            >
              {config?.export_scopes?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              )) || (
                <>
                  <option value="case">Case Scope</option>
                  <option value="batch">Batch Scope</option>
                  <option value="source">Single Source</option>
                </>
              )}
            </select>
          </div>

          <div>
            <label className="text-neutral-400 font-medium block">Scope Identifiers</label>
            <input
              type="text"
              placeholder="Comma-separated IDs, or leave blank"
              value={scopeIds}
              onChange={(e) => setScopeIds(e.target.value)}
              className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-neutral-200 font-mono"
            />
          </div>

          <div>
            <label className="text-neutral-400 font-medium block">Export Format</label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-neutral-200"
            >
              {config?.output_formats?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              )) || (
                <>
                  <option value="zip_bundle">ZIP Verifiable Bundle</option>
                  <option value="canonical_json">Canonical JSON</option>
                  <option value="pdf_report">Reconciliation PDF</option>
                </>
              )}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-6 pt-1">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeEvidence}
              onChange={(e) => setIncludeEvidence(e.target.checked)}
              className="rounded border-neutral-700 bg-neutral-950"
            />
            <span className="text-neutral-300">Include Source Bounding Box Evidence</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={masked}
              onChange={(e) => setMasked(e.target.checked)}
              className="rounded border-neutral-700 bg-neutral-950"
            />
            <span className="text-neutral-300">Enforce Column-Level Redaction / Masking</span>
          </label>
        </div>

        <div className="pt-2 flex justify-end">
          <button
            type="submit"
            disabled={isExporting}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium disabled:opacity-50"
          >
            <FileArchive className="w-4 h-4" />
            <span>Generate Export</span>
          </button>
        </div>
      </form>

      {/* Immediate Export Result */}
      {activeExport && (
        <div className="p-5 bg-neutral-950 border border-emerald-500/30 rounded-xl space-y-3">
          <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
            <CheckCircle2 className="w-4 h-4" />
            <span>Archive Generated Successfully</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 font-mono text-[11px] text-neutral-300">
            <div>
              <span className="text-neutral-500">Export ID:</span> {activeExport.export_id}
            </div>
            <div>
              <span className="text-neutral-500">Format:</span> {activeExport.format}
            </div>
            <div className="md:col-span-2 truncate">
              <span className="text-neutral-500">SHA-256 Content Hash:</span> {activeExport.content_hash}
            </div>
          </div>

          <div className="flex items-center gap-4 pt-2">
            <a
              href={activeExport.download_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download Archive</span>
            </a>

            {activeExport.signed_manifest_url && (
              <a
                href={activeExport.signed_manifest_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
              >
                <span>View Signed Manifest</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>
      )}

      {/* Export History Table */}
      <div className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-3">
        <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
          Export History ({historyData?.exports?.length || 0})
        </div>

        {historyData?.exports && historyData.exports.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[11px] text-left">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-500">
                  <th className="p-2">Export ID</th>
                  <th className="p-2">Format</th>
                  <th className="p-2">Created</th>
                  <th className="p-2">Content Hash</th>
                  <th className="p-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {historyData.exports.map((exp) => (
                  <tr key={exp.export_id} className="border-b border-neutral-800/40 hover:bg-neutral-800/20">
                    <td className="p-2 text-neutral-200">{exp.export_id}</td>
                    <td className="p-2 text-neutral-300">{exp.format}</td>
                    <td className="p-2 text-neutral-400">{formatBackendDate(exp.created_at)}</td>
                    <td className="p-2 text-neutral-400 truncate max-w-xs">{exp.content_hash}</td>
                    <td className="p-2 text-right">
                      <a
                        href={exp.download_url}
                        className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300"
                      >
                        <Download className="w-3 h-3" />
                        <span>Download</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-4 text-center text-neutral-500 bg-neutral-950/40 rounded">
            No historical export archives registered.
          </div>
        )}
      </div>
    </div>
  );
};
