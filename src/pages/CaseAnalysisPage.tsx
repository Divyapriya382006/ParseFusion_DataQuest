import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCompareArrows, Play } from "lucide-react";
import { listCases } from "../api/cases";
import { listSources } from "../api/sources";
import { analyzeCase, attachSourcesToCase, getCaseAnalysis } from "../api/caseAnalysis";
import { NotConnectedError } from "../api/errors";
import { ErrorAlert } from "../components/common/ErrorAlert";
import { AnalysisResult } from "../components/caseAnalysis/AnalysisResult";

export const CaseAnalysisPage: React.FC = () => {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const [caseId, setCaseId] = useState(searchParams.get("case_id") || "");
  const [picked, setPicked] = useState<string[]>([]);

  const casesQ = useQuery({ queryKey: ["cases"], queryFn: ({ signal }) => listCases(signal) });
  const sourcesQ = useQuery({ queryKey: ["sources"], queryFn: ({ signal }) => listSources(signal) });
  const cases = casesQ.data?.cases ?? [];
  const current = cases.find((c) => c.case_id === caseId);

  useEffect(() => {
    if (!caseId && cases.length) setCaseId(cases[0].case_id);
  }, [cases, caseId]);

  const analysisQ = useQuery({
    queryKey: ["caseAnalysis", caseId],
    queryFn: ({ signal }) => getCaseAnalysis(caseId, signal),
    enabled: Boolean(caseId),
    retry: (n, err) => !(err instanceof NotConnectedError && err.status === 404) && n < 1,
  });
  const run = useMutation({
    mutationFn: () => analyzeCase(caseId),
    onSuccess: (data) => qc.setQueryData(["caseAnalysis", caseId], data),
  });
  const attach = useMutation({
    mutationFn: () => attachSourcesToCase(caseId, picked),
    onSuccess: () => {
      setPicked([]);
      qc.invalidateQueries({ queryKey: ["cases"] });
    },
  });

  const analysis = run.data ?? analysisQ.data;
  const available = (sourcesQ.data?.sources ?? []).filter((s) => s.status === "completed" && !current?.source_ids.includes(s.source_id));

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-8 text-xs">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-neutral-100">
            <GitCompareArrows className="h-5 w-5 text-sky-400" /> Case Analysis
          </h1>
          <p className="mt-1 text-neutral-400">
            Every stage of the case pipeline: parsing of each document, normalized facts, cross-document comparison, and the final result.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={caseId}
            onChange={(e) => setCaseId(e.target.value)}
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-200"
          >
            {cases.length === 0 && <option value="">No cases yet</option>}
            {cases.map((c) => (
              <option key={c.case_id} value={c.case_id}>{c.title} ({c.source_ids.length} docs)</option>
            ))}
          </select>
          <button
            type="button"
            disabled={!caseId || run.isPending}
            onClick={() => run.mutate()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" /> {run.isPending ? "Analyzing…" : "Run analysis"}
          </button>
        </div>
      </div>

      {cases.length === 0 && !casesQ.isLoading && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 text-center text-neutral-400">
          Create a case on the <Link to="/" className="text-sky-300 hover:underline">upload page</Link> and process at least two documents into it.
        </div>
      )}

      {current && (
        <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
          <div className="text-neutral-400">
            Documents in this case: {current.source_ids.length}
            {current.source_ids.length < 2 && <span className="text-amber-300"> — add at least two to compare.</span>}
          </div>
          {available.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-neutral-500">Add processed documents:</span>
              {available.map((s) => (
                <label key={s.source_id} className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-neutral-300">
                  <input
                    type="checkbox"
                    checked={picked.includes(s.source_id)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.source_id] : p.filter((x) => x !== s.source_id)))}
                  />
                  {s.filename}
                </label>
              ))}
              <button
                type="button"
                disabled={!picked.length || attach.isPending}
                onClick={() => attach.mutate()}
                className="rounded border border-sky-600 px-2 py-1 text-sky-300 hover:bg-sky-600/10 disabled:opacity-50"
              >
                Add to case
              </button>
            </div>
          )}
        </div>
      )}

      {run.isError && <ErrorAlert error={run.error as Error} title="Analysis could not run" />}

      {analysis && <AnalysisResult analysis={analysis} />}

      {!analysis && caseId && !run.isPending && !analysisQ.isLoading && (
        <div className="rounded-xl border border-dashed border-neutral-800 p-6 text-center text-neutral-500">
          This case has not been analyzed yet. Click <span className="text-neutral-300">Run analysis</span>.
        </div>
      )}
    </div>
  );
};
