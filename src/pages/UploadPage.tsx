import React, { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Upload,
  Globe,
  Plus,
  Trash2,
  Play,
  FileCheck2,
  FolderPlus,
} from "lucide-react";
import { useConfig } from "../context/ConfigContext";
import { BackendNotConnected } from "../components/common/BackendNotConnected";
import { validateFile } from "../agents/01_fileValidation";
import type { FileValidationOutput } from "../agents/01_fileValidation";
import { ingestUrl } from "../agents/22_urlGuardWebRender";
import { createBatch } from "../api/batches";
import { listCases, createCase } from "../api/cases";
import { useQuery } from "@tanstack/react-query";
import { formatBytes } from "../lib/formatters";
import type { ID, ApiError } from "../types/canonical";

interface ValidatedSourceItem {
  id: string;
  file?: File;
  url?: string;
  sanitizedFilename: string;
  sizeBytes?: number;
  detectedMime?: string;
  sourceId?: ID;
  status: "validating" | "accepted" | "rejected";
  error?: ApiError;
}

export const UploadPage: React.FC = () => {
  const navigate = useNavigate();
  const { config, isNotConnected, notConnectedEndpoint, refetch } = useConfig();

  // Form states
  const [items, setItems] = useState<ValidatedSourceItem[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [selectedMode, setSelectedMode] = useState<string>("");
  const [selectedFormats, setSelectedFormats] = useState<string[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string>("");
  const [newCaseTitle, setNewCaseTitle] = useState("");
  const [showNewCaseInput, setShowNewCaseInput] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [featureFlagValues, setFeatureFlagValues] = useState<Record<string, boolean>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load existing cases from backend
  const { data: casesData } = useQuery({
    queryKey: ["casesList"],
    queryFn: ({ signal }) => listCases(signal),
    enabled: !isNotConnected,
  });

  // Set default mode and formats from backend config when config loads
  React.useEffect(() => {
    if (config) {
      if (!selectedMode && config.processing_modes?.[0]) {
        setSelectedMode(config.processing_modes[0].id);
      }
      if (selectedFormats.length === 0 && config.output_formats) {
        setSelectedFormats(config.output_formats.map((f) => f.id));
      }
      if (config.feature_flags) {
        setFeatureFlagValues(config.feature_flags);
      }
    }
  }, [config, selectedMode, selectedFormats.length]);

  if (isNotConnected) {
    return (
      <div className="p-8 max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-bold text-neutral-100">Document & Case Ingestion</h1>
          <p className="text-xs text-neutral-400 mt-1">
            Configure parallel extraction pipelines, source documents, and case parameters.
          </p>
        </div>
        <BackendNotConnected
          endpoint={notConnectedEndpoint || "/config"}
          onRetry={() => refetch()}
          message="Backend configuration is required to determine allowed file limits, processing modes, and output formats."
        />
      </div>
    );
  }

  // Handle file drop & selection
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setGeneralError(null);

    const limits = config?.limits;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Client-side limits check strictly against config.limits
      if (limits) {
        const fileMb = file.size / (1024 * 1024);
        if (fileMb > limits.max_file_mb) {
          setGeneralError(
            `File "${file.name}" exceeds the maximum configured limit of ${limits.max_file_mb} MB.`
          );
          continue;
        }
      }

      const tempId = `tmp_${Date.now()}_${i}`;
      const newItem: ValidatedSourceItem = {
        id: tempId,
        file,
        sanitizedFilename: file.name,
        sizeBytes: file.size,
        status: "validating",
      };

      setItems((prev) => [...prev, newItem]);

      // Call Agent 01: File Validation
      try {
        const res: FileValidationOutput = await validateFile({ file });
        setItems((prev) =>
          prev.map((it) =>
            it.id === tempId
              ? {
                  ...it,
                  sourceId: res.source_id,
                  sanitizedFilename: res.sanitized_filename,
                  detectedMime: res.detected_mime,
                  sizeBytes: res.size_bytes,
                  status: res.status,
                  error: res.error,
                }
              : it
          )
        );
      } catch (err: unknown) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === tempId
              ? {
                  ...it,
                  status: "rejected",
                  error: {
                    code: "VALIDATION_NETWORK_ERROR",
                    message: (err as Error).message,
                  },
                }
              : it
          )
        );
      }
    }
  };

  // Handle URL Ingestion calling Agent 22
  const handleAddUrl = async () => {
    if (!urlInput.trim()) return;
    const url = urlInput.trim();
    setUrlInput("");
    setGeneralError(null);

    const tempId = `url_${Date.now()}`;
    const newItem: ValidatedSourceItem = {
      id: tempId,
      url,
      sanitizedFilename: url,
      status: "validating",
    };

    setItems((prev) => [...prev, newItem]);

    try {
      const res = await ingestUrl({ url });
      setItems((prev) =>
        prev.map((it) =>
          it.id === tempId
            ? {
                ...it,
                sourceId: res.source_id,
                status: res.status === "allowed" ? "accepted" : "rejected",
                error: res.error || (res.reason ? { code: "URL_POLICY_RESTRICTED", message: res.reason } : undefined),
              }
            : it
        )
      );
    } catch (err: unknown) {
      setItems((prev) =>
        prev.map((it) =>
          it.id === tempId
            ? {
                ...it,
                status: "rejected",
                error: {
                  code: "URL_INGEST_FAILURE",
                  message: (err as Error).message,
                },
              }
            : it
        )
      );
    }
  };

  const handleRemoveItem = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  };

  const handleCreateCase = async () => {
    if (!newCaseTitle.trim()) return;
    try {
      const res = await createCase({ title: newCaseTitle.trim() });
      setSelectedCaseId(res.case_id);
      setNewCaseTitle("");
      setShowNewCaseInput(false);
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    }
  };

  // Launch pipeline
  const handleStartPipeline = async () => {
    const acceptedSourceIds = items
      .filter((it) => it.status === "accepted" && it.sourceId)
      .map((it) => it.sourceId!);

    if (acceptedSourceIds.length === 0) {
      setGeneralError("Please upload or ingest at least one accepted source document.");
      return;
    }

    setIsSubmitting(true);
    try {
      const batchRes = await createBatch({
        source_ids: acceptedSourceIds,
        mode: selectedMode,
        output_formats: selectedFormats,
        case_id: selectedCaseId || undefined,
        instructions: instructions || undefined,
        options: featureFlagValues,
      });

      navigate(`/batch?id=${batchRes.batch_id}&job_id=${batchRes.job_id}`);
    } catch (err: unknown) {
      setGeneralError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 text-xs">
      <div>
        <h1 className="text-xl font-bold text-neutral-100">Document & Case Ingestion</h1>
        <p className="text-xs text-neutral-400 mt-1">
          Upload multi-format documents or ingest web filings into the parallel extractor jury.
        </p>
      </div>

      {generalError && (
        <div className="p-3 bg-rose-950/30 border border-rose-800 text-rose-300 rounded-lg">
          {generalError}
        </div>
      )}

      {/* Upload Zone */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInputRef.current?.click()}
        className="border-2 border-dashed border-neutral-800 hover:border-neutral-700 bg-neutral-900/40 rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-colors"
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
          accept={config?.limits?.accepted_types?.join(",")}
        />
        <div className="w-12 h-12 rounded-xl bg-neutral-800/80 border border-neutral-700/60 flex items-center justify-center text-neutral-400 mb-3">
          <Upload className="w-6 h-6" />
        </div>
        <div className="font-medium text-neutral-200 text-sm">
          Drag and drop files here, or click to browse
        </div>
        <div className="text-neutral-500 text-[11px] mt-1 max-w-md">
          Supported: {config?.limits?.accepted_types?.join(", ") || "PDF, DOCX, XLSX, images, CSV, EML"} · Max {config?.limits?.max_file_mb} MB per file
        </div>
      </div>

      {/* URL Input */}
      <div className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-2">
        <label className="text-[11px] font-semibold text-neutral-300 flex items-center gap-1.5 uppercase tracking-wide">
          <Globe className="w-3.5 h-3.5 text-sky-400" />
          <span>Web Ingestion (URL Guard)</span>
        </label>
        <div className="flex gap-2">
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://example.com/quarterly-filing.html"
            className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-neutral-100 placeholder:text-neutral-600 text-xs"
          />
          <button
            type="button"
            onClick={handleAddUrl}
            className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-200 font-medium flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Ingest URL</span>
          </button>
        </div>
      </div>

      {/* Sources List */}
      {items.length > 0 && (
        <div className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-3">
          <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
            Staged Documents ({items.length})
          </div>

          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.id}
                className="p-3 bg-neutral-950/80 border border-neutral-800 rounded-lg flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileCheck2 className="w-4 h-4 text-sky-400 shrink-0" />
                  <div className="truncate">
                    <div className="font-medium text-neutral-200 truncate">
                      {item.sanitizedFilename}
                    </div>
                    <div className="text-[11px] text-neutral-500 font-mono flex items-center gap-2">
                      {item.sizeBytes && <span>{formatBytes(item.sizeBytes)}</span>}
                      {item.detectedMime && <span>{item.detectedMime}</span>}
                      {item.sourceId && <span>ID: {item.sourceId}</span>}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  {item.status === "validating" && (
                    <span className="text-amber-400 font-mono text-[11px] animate-pulse">
                      Validating...
                    </span>
                  )}
                  {item.status === "accepted" && (
                    <span className="text-emerald-400 font-mono text-[11px]">Accepted</span>
                  )}
                  {item.status === "rejected" && (
                    <span className="text-rose-400 font-mono text-[11px]" title={item.error?.message}>
                      Rejected
                    </span>
                  )}

                  <button
                    type="button"
                    onClick={() => handleRemoveItem(item.id)}
                    className="p-1.5 text-neutral-500 hover:text-neutral-300 rounded"
                    aria-label="Remove item"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pipeline Configuration Parameters */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Processing Mode */}
        <div className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-2">
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block">
            Processing Mode
          </label>
          <select
            value={selectedMode}
            onChange={(e) => setSelectedMode(e.target.value)}
            className="w-full bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-neutral-200"
          >
            {config?.processing_modes?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} {m.description ? `(${m.description})` : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Case Association */}
        <div className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
              Associate Case
            </label>
            <button
              type="button"
              onClick={() => setShowNewCaseInput(!showNewCaseInput)}
              className="text-sky-400 hover:text-sky-300 flex items-center gap-1 text-[11px]"
            >
              <FolderPlus className="w-3 h-3" />
              <span>{showNewCaseInput ? "Select Existing" : "Create New Case"}</span>
            </button>
          </div>

          {showNewCaseInput ? (
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="New Case Title..."
                value={newCaseTitle}
                onChange={(e) => setNewCaseTitle(e.target.value)}
                className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-3 py-1.5 text-neutral-200"
              />
              <button
                type="button"
                onClick={handleCreateCase}
                className="px-3 py-1.5 bg-neutral-800 text-neutral-200 rounded font-medium"
              >
                Create
              </button>
            </div>
          ) : (
            <select
              value={selectedCaseId}
              onChange={(e) => setSelectedCaseId(e.target.value)}
              className="w-full bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-neutral-200"
            >
              <option value="">No Case Binding (Unbound Batch)</option>
              {casesData?.cases?.map((c) => (
                <option key={c.case_id} value={c.case_id}>
                  {c.title} ({c.case_id})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Output Formats Multi-Select */}
      {config?.output_formats && config.output_formats.length > 0 && (
        <div className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-2">
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block">
            Target Output Formats
          </label>
          <p className="text-[11px] text-neutral-500">
            Each selected format will be generated as a downloadable export when processing finishes.
          </p>
          <div className="flex flex-wrap gap-2">
            {config.output_formats.map((fmt) => {
              const isChecked = selectedFormats.includes(fmt.id);
              return (
                <button
                  key={fmt.id}
                  type="button"
                  onClick={() => {
                    setSelectedFormats((prev) =>
                      isChecked ? prev.filter((id) => id !== fmt.id) : [...prev, fmt.id]
                    );
                  }}
                  className={`px-3 py-1.5 rounded-lg border font-mono text-xs transition-colors ${
                    isChecked
                      ? "bg-sky-500/20 border-sky-500/40 text-sky-200"
                      : "bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-neutral-300"
                  }`}
                >
                  {fmt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Free-text Analysis Instructions */}
      <div className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-2">
        <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block">
          Custom Analysis Instructions (Optional)
        </label>
        <textarea
          rows={2}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="E.g., Compare line-item reconciliations between invoice vouchers and ledger receipts..."
          className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2.5 text-neutral-200 placeholder:text-neutral-600 text-xs"
        />
      </div>

      {/* Feature Flags / Advanced Options */}
      {config?.feature_flags && Object.keys(config.feature_flags).length > 0 && (
        <div className="p-4 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-3">
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block">
            Pipeline Configuration Options (Backend Flags)
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
            {Object.entries(config.feature_flags).map(([key]) => (
              <label
                key={key}
                className="flex items-center gap-2 p-2 bg-neutral-950 rounded border border-neutral-800/80 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={featureFlagValues[key] ?? false}
                  onChange={(e) =>
                    setFeatureFlagValues((prev) => ({ ...prev, [key]: e.target.checked }))
                  }
                  className="rounded border-neutral-700 bg-neutral-900"
                />
                <span className="font-mono text-[11px] text-neutral-300 truncate">{key}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Submit Button */}
      <div className="pt-2 flex justify-end">
        <button
          type="button"
          onClick={handleStartPipeline}
          disabled={isSubmitting || items.filter((it) => it.status === "accepted").length === 0}
          className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs shadow-md transition-colors disabled:opacity-50"
        >
          <Play className="w-4 h-4 fill-white" />
          <span>Launch Ingestion Pipeline</span>
        </button>
      </div>
    </div>
  );
};
