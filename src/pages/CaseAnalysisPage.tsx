import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleSlash, FileSearch, GitCompareArrows, Play, Sigma, XCircle } from "lucide-react";
import { listCases } from "../api/cases";
import { listSources } from "../api/sources";
import {
  analyzeCase,
  attachSourcesToCase,
  getCaseAnalysis,
  type CaseAnalysis,
  type CaseComparison,
  type CaseFact,
  type CaseFinding,
  type CaseNotComparable,
  type SourceParseSummary,
} from "../api/caseAnalysis";
import { NotConnectedError } from "../api/errors";
import { ConfidenceIndicator } from "../components/common/ConfidenceIndicator";
import { ErrorAlert } from "../components/common/ErrorAlert";
import { EvidenceHover } from "../components/evidence/EvidenceHover";
import { HighlightScope } from "../components/evidence/HighlightScope";
import { HighlightedPagesPreview } from "../components/evidence/HighlightedPagesPreview";
import { formatBackendDate } from "../lib/formatters";
import type { EvidenceReference } from "../types/canonical";

const VERDICT: Record<string, { label: string; tone: string; Icon: React.ElementType }> = {
  discrepancies_found: { label: "Discrepancies found", tone: "border-amber-500/40 bg-amber-500/10 text-amber-300", Icon: AlertTriangle },
  consistent: { label: "Documents consistent", tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", Icon: CheckCircle2 },
  insufficient_data: { label: "Not enough comparable data", tone: "border-neutral-600 bg-neutral-800/40 text-neutral-300", Icon: CircleSlash },
  failed: { label: "Analysis failed", tone: "border-rose-500/40 bg-rose-500/10 text-rose-300", Icon: XCircle },
};

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);

function stageOutput<T>(analysis: CaseAnalysis | undefined, stage: string): T | undefined {
  return analysis?.stages.find((s) => s.stage === stage)?.output as T | undefined;
}

const EvidenceChip: React.FC<{ ev: EvidenceReference }> = ({ ev }) => (
  <EvidenceHover evidence={ev} as="span" className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] text-sky-300 hover:border-sky-500/60">
    <FileSearch className="h-3 w-3" />
    {ev.filename || ev.source_id} · p{ev.page_number}
  </EvidenceHover>
);

const SectionTitle: React.FC<{ n: number; title: string; agents: string; status?: string; children?: React.ReactNode }> = ({ n, title, agents, status, children }) => (
  <div className="flex flex-wrap items-center justify-between gap-2">
    <div className="flex items-center gap-2">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-sky-600/20 text-[11px] font-bold text-sky-300">{n}</span>
      <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
      <span className="font-mono text-[10px] text-neutral-500">agents {agents}</span>
      {status && (
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${status === "completed" ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-300"}`}>
          {status}
        </span>
      )}
    </div>
    {children}
  </div>
);

const ParsingStage: React.FC<{ sources: SourceParseSummary[] }> = ({ sources }) => (
  <div className="overflow-x-auto rounded-lg border border-neutral-800">
    <table className="w-full text-left text-[11px]">
      <thead className="bg-neutral-900/80 text-neutral-500">
        <tr>
          {["Document", "Route", "Pages", "Blocks", "Tables", "Figures", "Methods", "OCR agreement", "Reading order", "Needs review", "Document confidence"].map((h) => (
            <th key={h} className="px-3 py-2 font-medium">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sources.map((s) => (
          <tr key={s.source_id} className="border-t border-neutral-800 text-neutral-300">
            <td className="px-3 py-2">
              <Link to={`/dashboard?source_id=${s.source_id}`} className="text-sky-300 hover:underline">{s.filename || s.source_id}</Link>
              {s.error && <div className="text-rose-300">{s.error.message}</div>}
            </td>
            <td className="px-3 py-2 font-mono">{s.route || "—"}</td>
            <td className="px-3 py-2">{s.pages}</td>
            <td className="px-3 py-2">{s.blocks}</td>
            <td className="px-3 py-2">{s.tables}</td>
            <td className="px-3 py-2">{s.figures}</td>
            <td className="px-3 py-2 font-mono text-[10px]">
              {Object.entries(s.blocks_by_method).map(([m, c]) => `${m}: ${c}`).join(", ") || "—"}
            </td>
            <td className="px-3 py-2">{pct(s.ocr_agreement_mean)}</td>
            <td className="px-3 py-2">{pct(s.reading_order_confidence)}</td>
            <td className="px-3 py-2">{s.needs_review}</td>
            <td className="px-3 py-2">{s.document_confidence !== null ? <ConfidenceIndicator confidence={s.document_confidence} size="sm" /> : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const FactsStage: React.FC<{ facts: CaseFact[] }> = ({ facts }) =>
  facts.length === 0 ? (
    <p className="text-[11px] text-neutral-500">No facts were extracted from the case documents.</p>
  ) : (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left text-[11px]">
        <thead className="bg-neutral-900/80 text-neutral-500">
          <tr>
            {["Subject", "Metric", "As written", "Normalized", "Period", "Basis", "Rule", "Confidence", "Evidence"].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {facts.map((f) => (
            <tr key={f.fact_id} className="border-t border-neutral-800 align-top text-neutral-300">
              <td className="px-3 py-2">{f.subject || <span className="text-neutral-500">not named</span>}</td>
              <td className="px-3 py-2 font-medium text-neutral-100">{f.metric}</td>
              <td className="px-3 py-2">
                <EvidenceHover evidence={f.evidence[0]} as="span" className="cursor-help underline decoration-dotted decoration-neutral-600">
                  {f.raw_value}
                </EvidenceHover>
              </td>
              <td className="px-3 py-2 font-mono text-neutral-100">
                {String(f.normalized_value ?? "—")} {f.currency || ""} {f.unit || ""}
              </td>
              <td className="px-3 py-2 font-mono text-[10px]">{f.period_start ? `${f.period_start} → ${f.period_end ?? ""}` : "—"}</td>
              <td className="px-3 py-2">{f.basis || "—"}</td>
              <td className="px-3 py-2 font-mono text-[10px] text-neutral-500">{f.normalization_rule}</td>
              <td className="px-3 py-2">
                <ConfidenceIndicator confidence={f.confidence} size="sm" />
                {f.ambiguity_notes && f.ambiguity_notes.length > 0 && (
                  <div className="mt-1 max-w-[220px] text-[10px] text-amber-300/80">{f.ambiguity_notes.join("; ")}</div>
                )}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {f.evidence.map((ev, i) => <EvidenceChip key={i} ev={ev} />)}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

const ComparisonsTable: React.FC<{ comparisons: CaseComparison[]; factsById: Map<string, CaseFact> }> = ({ comparisons, factsById }) => (
  <div className="overflow-x-auto rounded-lg border border-neutral-800">
    <table className="w-full text-left text-[11px]">
      <thead className="bg-neutral-900/80 text-neutral-500">
        <tr>
          {["Subject / metric", "Value A", "Value B", "Difference", "Tolerance", "Result", "Checks", "Confidence"].map((h) => (
            <th key={h} className="px-3 py-2 font-medium">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {comparisons.map((c) => {
          const [fa, fb] = c.fact_ids.map((id) => factsById.get(id));
          const evs = [fa, fb].flatMap((f) => f?.evidence ?? []);
          return (
            <tr key={c.comparison_id} className="border-t border-neutral-800 align-top text-neutral-300">
              <td className="px-3 py-2">
                <HighlightScope evidences={evs}>
                  <div className="font-medium text-neutral-100">{c.metric}</div>
                  <div className="text-neutral-500">{c.subject}</div>
                </HighlightScope>
              </td>
              <td className="px-3 py-2 font-mono">
                <EvidenceHover evidence={fa?.evidence[0]} as="span">{c.value_a} {c.currency || ""}</EvidenceHover>
              </td>
              <td className="px-3 py-2 font-mono">
                <EvidenceHover evidence={fb?.evidence[0]} as="span">{c.value_b} {c.currency || ""}</EvidenceHover>
              </td>
              <td className="px-3 py-2 font-mono">
                {c.absolute_difference} ({c.percentage_difference.toFixed(2)}%)
              </td>
              <td className="px-3 py-2 font-mono text-neutral-500">
                ±{c.tolerance_abs} / {c.tolerance_pct}%
              </td>
              <td className="px-3 py-2">
                {c.within_tolerance ? <span className="text-emerald-300">within tolerance</span> : <span className="text-amber-300">differs</span>}
              </td>
              <td className="px-3 py-2">
                <div className="flex max-w-[260px] flex-wrap gap-1">
                  {c.checks.map((ck) => (
                    <span key={ck.name} title={ck.detail} className={`rounded px-1 py-0.5 font-mono text-[9px] ${ck.status === "pass" ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-300"}`}>
                      {ck.name}
                    </span>
                  ))}
                </div>
              </td>
              <td className="px-3 py-2">{c.confidence !== null ? <ConfidenceIndicator confidence={c.confidence} size="sm" /> : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

const NotComparableList: React.FC<{ items: CaseNotComparable[] }> = ({ items }) => (
  <ul className="space-y-1 text-[11px]">
    {items.map((nc, i) => (
      <li key={i} className="rounded border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-neutral-400">
        <span className="font-medium text-neutral-200">{nc.metric}</span> ({nc.subject}) — {nc.reason}
      </li>
    ))}
  </ul>
);

const FindingCard: React.FC<{ f: CaseFinding }> = ({ f }) => (
  <HighlightScope evidences={f.evidence_references} className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${f.severity === "high" ? "bg-rose-500/20 text-rose-300" : f.severity === "medium" ? "bg-amber-500/20 text-amber-300" : "bg-neutral-700 text-neutral-300"}`}>
          {f.severity}
        </span>
        <span className="text-xs font-semibold text-neutral-100">{f.title}</span>
      </div>
      <ConfidenceIndicator confidence={f.confidence} size="sm" />
    </div>
    <p className="text-[11px] text-neutral-300">{f.statement}</p>
    {f.possible_explanations.length > 0 && (
      <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-neutral-400">
        {f.possible_explanations.map((e, i) => <li key={i}>{e.explanation}</li>)}
      </ul>
    )}
    <div className="flex flex-wrap items-center gap-1">
      {f.evidence_references.map((ev, i) => <EvidenceChip key={i} ev={ev} />)}
    </div>
    <p className="text-[10px] text-neutral-500">{f.recommended_review_action}</p>
  </HighlightScope>
);

export const CaseAnalysisPage: React.FC = () => {
  const qc = useQueryClient();
  const [caseId, setCaseId] = useState("");
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
  const parsing = stageOutput<SourceParseSummary[]>(analysis, "parsing") ?? [];
  const factsOut = stageOutput<{ facts: CaseFact[]; warnings: { code: string; message: string }[] }>(analysis, "fact_normalization");
  const reasoning = stageOutput<{ comparisons: CaseComparison[]; not_comparable: CaseNotComparable[]; findings: CaseFinding[]; warnings: { code: string; message: string }[] }>(analysis, "cross_document_reasoning");
  const facts = factsOut?.facts ?? [];
  const factsById = useMemo(() => new Map(facts.map((f) => [f.fact_id, f])), [facts]);
  const stageStatus = (name: string) => analysis?.stages.find((s) => s.stage === name);
  const verdict = analysis ? VERDICT[analysis.final.verdict] ?? VERDICT.failed : undefined;
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

      {analysis && verdict && (
        <>
          {/* Final output */}
          <div className={`space-y-3 rounded-xl border p-5 ${verdict.tone}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <verdict.Icon className="h-5 w-5" />
                <span className="text-base font-bold">{verdict.label}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-neutral-400">Final confidence</span>
                <ConfidenceIndicator confidence={analysis.final.confidence} />
              </div>
            </div>
            <p className="text-sm text-neutral-200">{analysis.final.summary ?? analysis.final.error?.message}</p>
            <div className="flex flex-wrap gap-4 text-[11px] text-neutral-300">
              <span>Documents: {analysis.final.documents ?? "—"}</span>
              <span>Facts: {analysis.final.facts ?? "—"}</span>
              <span>Comparisons: {analysis.final.comparisons ?? "—"}</span>
              <span>Not comparable: {analysis.final.not_comparable ?? "—"}</span>
              <span>Findings: {analysis.final.findings ?? "—"}</span>
              {analysis.final.human_review_required && <span className="text-amber-300">Human review required</span>}
            </div>
            {analysis.final.confidence_basis && (
              <p className="flex items-center gap-1 text-[10px] text-neutral-400">
                <Sigma className="h-3 w-3" /> Confidence = {analysis.final.confidence_basis}
              </p>
            )}
            <p className="text-[10px] text-neutral-500">Analyzed {formatBackendDate(analysis.analyzed_at)}</p>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-6">
              <section className="space-y-2">
                <SectionTitle n={1} title="Parsing output per document" agents="01–04, 08" status={stageStatus("parsing")?.status} />
                <ParsingStage sources={parsing} />
              </section>

              <section className="space-y-2">
                <SectionTitle n={2} title="Normalized facts" agents="15" status={stageStatus("fact_normalization")?.status} />
                {stageStatus("fact_normalization")?.error && <ErrorAlert error={stageStatus("fact_normalization")!.error as never} />}
                {factsOut && <FactsStage facts={facts} />}
                {factsOut?.warnings?.length ? (
                  <p className="text-[10px] text-amber-300/80">{factsOut.warnings.map((w) => w.message).join(" · ")}</p>
                ) : null}
              </section>

              <section className="space-y-2">
                <SectionTitle n={3} title="Cross-document reasoning" agents="16" status={stageStatus("cross_document_reasoning")?.status} />
                {stageStatus("cross_document_reasoning")?.error && <ErrorAlert error={stageStatus("cross_document_reasoning")!.error as never} />}
                {reasoning && (
                  <div className="space-y-4">
                    {reasoning.findings.length > 0 && (
                      <div className="space-y-2">
                        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Findings</h3>
                        {reasoning.findings.map((f) => <FindingCard key={f.finding_id} f={f} />)}
                      </div>
                    )}
                    <div className="space-y-2">
                      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Comparisons ({reasoning.comparisons.length})</h3>
                      {reasoning.comparisons.length ? (
                        <ComparisonsTable comparisons={reasoning.comparisons} factsById={factsById} />
                      ) : (
                        <p className="text-[11px] text-neutral-500">No pair of facts was comparable.</p>
                      )}
                    </div>
                    {reasoning.not_comparable.length > 0 && (
                      <div className="space-y-2">
                        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Not comparable ({reasoning.not_comparable.length})</h3>
                        <NotComparableList items={reasoning.not_comparable} />
                      </div>
                    )}
                    {reasoning.warnings.length > 0 && (
                      <p className="text-[10px] text-amber-300/80">
                        {Array.from(new Set(reasoning.warnings.map((w) => `${w.code}: ${w.message}`))).join(" · ")}
                      </p>
                    )}
                  </div>
                )}
              </section>
            </div>
            <aside className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Evidence on the page</h3>
              <HighlightedPagesPreview />
            </aside>
          </div>
        </>
      )}

      {!analysis && caseId && !run.isPending && !analysisQ.isLoading && (
        <div className="rounded-xl border border-dashed border-neutral-800 p-6 text-center text-neutral-500">
          This case has not been analyzed yet. Click <span className="text-neutral-300">Run analysis</span>.
        </div>
      )}
    </div>
  );
};
