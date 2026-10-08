import React, { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { getSourceDocument } from "../../api/sources";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, CircleSlash, FileSearch, Info, Sigma, XCircle } from "lucide-react";
import type {
  CaseAnalysis,
  CaseComparison,
  CaseFact,
  CaseFinding,
  CaseNotComparable,
  FunnelStage,
  ParseScore,
  ReasoningReport,
  ScoreComponent,
  ReportDocument,
  SourceParseSummary,
} from "../../api/caseAnalysis";
import { ConfidenceIndicator } from "../common/ConfidenceIndicator";
import { ErrorAlert } from "../common/ErrorAlert";
import { EvidenceHover } from "../evidence/EvidenceHover";
import { HighlightScope } from "../evidence/HighlightScope";
import { HighlightedPagesPreview } from "../evidence/HighlightedPagesPreview";
import { formatBackendDate } from "../../lib/formatters";
import type { EvidenceReference } from "../../types/canonical";

/** Renders the output of a case analysis (POST /cases/{id}/analyze): every stage and the final result.
 *  Used by the Case Analysis page and by the Batch Pipeline page. */

export const VERDICT: Record<string, { label: string; tone: string; Icon: React.ElementType }> = {
  discrepancies_found: { label: "Findings for review", tone: "border-amber-500/40 bg-amber-500/10 text-amber-300", Icon: AlertTriangle },
  consistent: { label: "Comparisons made, no discrepancy flagged", tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", Icon: CheckCircle2 },
  insufficient_data: { label: "Not scored: insufficient comparable data", tone: "border-neutral-600 bg-neutral-800/40 text-neutral-300", Icon: CircleSlash },
  not_scored: { label: "Not scored: insufficient comparable data", tone: "border-neutral-600 bg-neutral-800/40 text-neutral-300", Icon: CircleSlash },
  failed: { label: "Analysis failed", tone: "border-rose-500/40 bg-rose-500/10 text-rose-300", Icon: XCircle },
};

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);

export function stageOutput<T>(analysis: CaseAnalysis | undefined, stage: string): T | undefined {
  return analysis?.stages.find((s) => s.stage === stage)?.output as T | undefined;
}

const EvidenceChip: React.FC<{ ev: EvidenceReference }> = ({ ev }) => (
  <EvidenceHover evidence={ev} as="span" className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] text-sky-300 hover:border-sky-500/60">
    <FileSearch className="h-3 w-3" />
    {ev.filename || ev.source_id} · p{ev.page_number}
  </EvidenceHover>
);

export const SectionTitle: React.FC<{ n: number; title: string; agents: string; status?: string; children?: React.ReactNode }> = ({ n, title, agents, status, children }) => (
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


/* ------------------------------------------------------------------------------------------ small pieces */

const NOT_PROVIDED = <span className="text-neutral-500">not provided by backend</span>;

const Bar: React.FC<{ label: string; value: number | null | undefined; hint?: string }> = ({ label, value, hint }) => (
  <div className="space-y-0.5" title={hint}>
    <div className="flex justify-between gap-2 text-[10px] text-neutral-400">
      <span className="truncate">{label.replace(/_/g, " ")}</span>
      <span className="font-mono text-neutral-200">{value == null ? "—" : value.toFixed(2)}</span>
    </div>
    <div className="h-1.5 rounded bg-neutral-800">
      <div className="h-1.5 rounded bg-sky-500" style={{ width: `${Math.max(0, Math.min(1, value ?? 0)) * 100}%` }} />
    </div>
  </div>
);

const ScoreValue: React.FC<{ value: number | null | undefined }> = ({ value }) =>
  value == null ? <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">not scored</span> : <ConfidenceIndicator confidence={value} size="sm" />;

const ParseScoreBlock: React.FC<{ ps: ParseScore | null | undefined }> = ({ ps }) => {
  if (!ps) return NOT_PROVIDED;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-neutral-500">Parse score</span>
        <ScoreValue value={ps.value} />
      </div>
      {Object.entries(ps.components).map(([k, v]) => <Bar key={k} label={k} value={v} />)}
      {ps.cap?.applied && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200">
          Capped at {ps.cap.max} because {ps.cap.reason} <span className="font-mono text-amber-300/70">({ps.cap.config_key})</span>
        </div>
      )}
      {ps.formula && <div className="text-[10px] text-neutral-500">= {ps.formula}</div>}
    </div>
  );
};

const originLabel = (f: CaseFact) => {
  const o = f.origin;
  if (!o) return "—";
  if (o.type === "table_cell") return "table cell";
  if (o.type === "key_value") return "key-value";
  return o.type;
};

/* ------------------------------------------------------------------------------------------ final parse (union) */

type UnionOut = {
  documents: { source_id: string; filename: string; pages: number; blocks: number; parse_score: number | null; unread_pages?: number }[];
  pages: number;
  blocks: number;
  tables: number;
  figures: number;
  unread_pages?: number;
  blocks_by_type: Record<string, number>;
  blocks_by_method: Record<string, number>;
  needs_review: number;
  parse_score: { value: number | null; formula: string; capped_documents: string[] };
  warnings: { code: string; message: string; count: number; documents: string[] }[];
};

const UNION_PREVIEW = 40;

const UnionParse: React.FC<{ u: UnionOut; excluded?: { source_id: string; filename: string; reason: string }[] }> = ({ u, excluded }) => {
  const [all, setAll] = useState(false);
  const docs = useQueries({
    queries: u.documents.map((d) => ({
      queryKey: ["unionSourceDocument", d.source_id, d.blocks],
      queryFn: ({ signal }: { signal: AbortSignal }) => getSourceDocument(d.source_id, signal),
      staleTime: Infinity,
    })),
  });
  const merged = useMemo(
    () =>
      docs.flatMap((q, i) =>
        (q.data?.pages ?? []).flatMap((pg) =>
          [...pg.blocks]
            .sort((a, b) => (a.reading_order_index ?? 0) - (b.reading_order_index ?? 0))
            .map((b) => ({ doc: u.documents[i].filename, page: pg.page_number, b }))
        )
      ),
    [docs, u.documents]
  );
  const loading = docs.some((q) => q.isLoading);
  const shown = all ? merged : merged.slice(0, UNION_PREVIEW);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {([["documents", u.documents.length], ["pages", u.pages], ["blocks", u.blocks], ["tables", u.tables], ["figures", u.figures], ["needs review", u.needs_review]] as const).map(([k, v]) => (
          <div key={k} className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-neutral-500">{k}</div>
            <div className="font-mono text-sm text-neutral-100">{v}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-neutral-300">
        <span className="text-[10px] uppercase tracking-wide text-neutral-500">Final parse score</span>
        <ScoreValue value={u.parse_score.value} />
        <span className="text-[10px] text-neutral-500">= {u.parse_score.formula}</span>
        {u.parse_score.capped_documents.length > 0 && (
          <span className="text-[10px] text-amber-300">capped documents: {u.parse_score.capped_documents.join(", ")}</span>
        )}
        {!!u.unread_pages && <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] text-rose-300">{u.unread_pages} page(s) unread</span>}
      </div>
      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-[11px]">
          <thead className="bg-neutral-900/80 text-neutral-500">
            <tr><th className="px-3 py-1.5">Document (partial parse)</th><th className="px-3 py-1.5">Pages</th><th className="px-3 py-1.5">Blocks</th><th className="px-3 py-1.5">Share of final parse</th><th className="px-3 py-1.5">Parse score</th></tr>
          </thead>
          <tbody>
            {u.documents.map((d) => (
              <tr key={d.source_id} className="border-t border-neutral-800 text-neutral-300">
                <td className="px-3 py-1.5">{d.filename}{d.unread_pages ? <span className="ml-2 text-rose-300">{d.unread_pages} unread page(s)</span> : null}</td>
                <td className="px-3 py-1.5 font-mono">{d.pages}</td>
                <td className="px-3 py-1.5 font-mono">{d.blocks}</td>
                <td className="px-3 py-1.5"><Bar label="" value={u.blocks ? d.blocks / u.blocks : null} /></td>
                <td className="px-3 py-1.5"><ScoreValue value={d.parse_score} /></td>
              </tr>
            ))}
            {excluded?.map((d) => (
              <tr key={d.source_id} className="border-t border-neutral-800 text-rose-300">
                <td className="px-3 py-1.5" colSpan={5}>{d.filename}: not in the final parse ({d.reason})</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {u.warnings.length > 0 && (
        <ul className="space-y-0.5 text-[10px] text-amber-200/90">
          {u.warnings.map((w) => (
            <li key={w.code}><span className="font-mono text-amber-300">{w.code}</span> ×{w.count} — {w.message} <span className="text-neutral-500">({Array.from(new Set(w.documents)).join(", ")})</span></li>
          ))}
        </ul>
      )}
      <div className="rounded-lg border border-neutral-800">
        <div className="bg-neutral-900 px-3 py-1.5 text-[10px] uppercase tracking-wider text-neutral-500">
          Merged content of all documents, in document → page → reading order
        </div>
        {loading && <div className="px-3 py-2 text-neutral-500">Loading document content…</div>}
        <ol className="divide-y divide-neutral-800/80">
          {shown.map(({ doc, page, b }) => (
            <li key={b.block_id} className="flex gap-3 px-3 py-1.5">
              <span className="w-40 shrink-0 truncate font-mono text-[10px] text-neutral-500">{doc} · p{page} · {b.type}</span>
              <span className="min-w-0 flex-1 truncate text-neutral-200">
                {b.locked || b.masked ? "restricted" : b.raw_text || ("caption" in b && (b as { caption?: string }).caption) || `(${b.type})`}
              </span>
              <ConfidenceIndicator confidence={b.confidence} size="sm" />
            </li>
          ))}
        </ol>
        {merged.length > UNION_PREVIEW && (
          <button type="button" onClick={() => setAll((v) => !v)} className="w-full bg-neutral-900 px-3 py-1.5 text-[11px] text-neutral-300 hover:bg-neutral-800">
            {all ? "Show fewer" : `Show all ${merged.length} blocks`}
          </button>
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------ section 2 */

const FactRows: React.FC<{ facts: CaseFact[] }> = ({ facts }) => (
  <div className="overflow-x-auto rounded-lg border border-neutral-800">
    <table className="w-full text-left text-[11px]">
      <thead className="bg-neutral-900/80 text-neutral-500">
        <tr>
          {["Entity", "Attribute", "As written", "Normalized", "Origin", "Score", "Ambiguity notes", "Evidence"].map((h) => (
            <th key={h} className="px-3 py-2 font-medium">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {facts.map((f) => (
          <tr key={f.fact_id} className="border-t border-neutral-800 align-top text-neutral-300">
            <td className="px-3 py-2">{f.subject || <span className="text-neutral-500">not named</span>}</td>
            <td className="px-3 py-2">
              <div className="font-medium text-neutral-100">{f.metric}</div>
              {f.origin?.type === "table_cell" && (
                <div className="mt-0.5 font-mono text-[10px] text-neutral-500">
                  row “{f.origin.row_label}”{f.origin.column_headers?.length ? ` × column “${f.origin.column_headers.join(" / ")}”` : ""}
                </div>
              )}
            </td>
            <td className="px-3 py-2">
              <EvidenceHover evidence={f.evidence[0]} as="span" className="cursor-help underline decoration-dotted decoration-neutral-600">
                {f.raw_value}
              </EvidenceHover>
            </td>
            <td className="px-3 py-2 font-mono text-neutral-100">
              {String(f.normalized_value ?? "—")} {f.currency || ""} {f.unit || ""}
              <div className="text-[10px] text-neutral-500">
                {f.period_start ? `${f.period_start} → ${f.period_end ?? ""}` : "no period"} · basis {f.basis || "—"}
              </div>
            </td>
            <td className="px-3 py-2">
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">{originLabel(f)}</span>
              <div className="mt-1 font-mono text-[9px] text-neutral-600">{f.normalization_rule}</div>
            </td>
            <td className="px-3 py-2"><ConfidenceIndicator confidence={f.confidence} size="sm" /></td>
            <td className="px-3 py-2 max-w-[240px] text-[10px] text-amber-300/80">{f.ambiguity_notes?.join("; ") || "—"}</td>
            <td className="px-3 py-2">
              <div className="flex flex-wrap gap-1">{f.evidence.map((ev, i) => <EvidenceChip key={i} ev={ev} />)}</div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const FactsByDocument: React.FC<{ facts: CaseFact[]; report?: ReasoningReport }> = ({ facts, report }) => {
  const docs: { source_id: string; filename: string; meta?: ReportDocument }[] = report
    ? report.documents.map((d) => ({ source_id: d.source_id, filename: d.filename, meta: d }))
    : Array.from(new Set(facts.map((f) => f.evidence[0]?.source_id))).map((sid) => ({
        source_id: sid,
        filename: facts.find((f) => f.evidence[0]?.source_id === sid)?.evidence[0]?.filename || sid,
      }));
  return (
    <div className="space-y-4">
      {docs.map((d) => {
        const own = facts.filter((f) => f.evidence[0]?.source_id === d.source_id);
        const fm = d.meta?.facts;
        const skippedHere = report?.skipped_candidates.filter((c) => c.source_id === d.source_id) ?? [];
        return (
          <div key={d.source_id} className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-900/30 p-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-semibold text-neutral-100">{d.filename}</span>
              {fm ? (
                <span className="flex flex-wrap gap-3 font-mono text-[10px] text-neutral-400">
                  <span>candidates {fm.candidates ?? "—"}</span>
                  <span className="text-emerald-300">accepted {fm.accepted}</span>
                  <span className={fm.skipped_total ? "text-amber-300" : ""}>skipped {fm.skipped_total ?? "—"}</span>
                  <span>unclassified numbers {fm.unclassified_numbers ?? "—"}</span>
                </span>
              ) : (
                <span className="text-[10px]">{NOT_PROVIDED} (re-run the analysis)</span>
              )}
            </div>
            {fm?.zero_fact_reason && (
              <div className="flex items-start gap-1.5 rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-neutral-300">
                <Info className="mt-0.5 h-3 w-3 shrink-0 text-sky-300" /> No facts: {fm.zero_fact_reason}
              </div>
            )}
            {skippedHere.length > 0 && (
              <details className="rounded border border-neutral-800 bg-neutral-950/60 px-2 py-1.5">
                <summary className="cursor-pointer text-[11px] text-amber-200">
                  Skipped candidates ({skippedHere.length}):{" "}
                  {fm?.skipped.map((s) => `${s.reason_code} ×${s.count}`).join(", ")}
                </summary>
                <table className="mt-2 w-full text-left text-[10px]">
                  <thead className="text-neutral-500">
                    <tr><th className="py-1 pr-3">Reason</th><th className="py-1 pr-3">Failing field</th><th className="py-1 pr-3">Raw text</th><th className="py-1">Ref</th></tr>
                  </thead>
                  <tbody>
                    {skippedHere.map((c, i) => (
                      <tr key={i} className="border-t border-neutral-800 text-neutral-300">
                        <td className="py-1 pr-3 font-mono text-amber-300">{c.reason_code}</td>
                        <td className="py-1 pr-3 font-mono">{c.failing_field || "—"}</td>
                        <td className="py-1 pr-3">{c.raw_text}</td>
                        <td className="py-1 font-mono text-neutral-600">{c.ref_id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
            {own.length > 0 && <FactRows facts={own} />}
          </div>
        );
      })}
      {docs.length === 0 && <p className="text-[11px] text-neutral-500">No documents were analysed.</p>}
    </div>
  );
};

/* ------------------------------------------------------------------------------------------ section 3 */

const InputCards: React.FC<{ report: ReasoningReport }> = ({ report }) => (
  <div className="flex gap-3 overflow-x-auto pb-2">
    {report.documents.map((d) => (
      <div key={d.source_id} className="w-[300px] shrink-0 space-y-2 rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
        <div className="flex items-start justify-between gap-2">
          <Link to={`/dashboard?source_id=${d.source_id}`} className="font-semibold text-sky-300 hover:underline">{d.filename}</Link>
          <span className="font-mono text-[10px] text-neutral-500">{d.parse.route || ""}</span>
        </div>
        <div className="text-[10px] text-neutral-400" title={d.doc_type_guess?.method}>
          Type guess:{" "}
          {d.doc_type_guess ? (
            <span className="text-neutral-200">
              {d.doc_type_guess.label} <span className="font-mono text-neutral-500">({d.doc_type_guess.confidence.toFixed(2)}; matched {d.doc_type_guess.matched.join(", ")})</span>
            </span>
          ) : d.doc_type_guess === null ? (
            <span className="text-neutral-500">no type rule matched</span>
          ) : NOT_PROVIDED}
        </div>
        <div className="grid grid-cols-4 gap-1 text-center font-mono text-[10px] text-neutral-400">
          {(["pages", "blocks", "tables", "figures"] as const).map((k) => (
            <div key={k} className="rounded bg-neutral-900 py-1"><div className="text-neutral-100">{d.parse[k]}</div>{k}</div>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 font-mono text-[10px]">
          {Object.entries(d.parse.blocks_by_method || {}).map(([m, n]) => (
            <span key={m} className="rounded bg-sky-900/40 px-1.5 py-0.5 text-sky-200">{m} × {n}</span>
          ))}
        </div>
        <ParseScoreBlock ps={d.parse_score} />
        <div className="text-[10px] text-neutral-400">
          Needs review: <span className={d.parse.needs_review ? "text-amber-300" : "text-emerald-300"}>{d.parse.needs_review}</span>
          {d.parse.unverified_blocks ? ` (incl. ${d.parse.unverified_blocks} not cross-checked)` : ""}
        </div>
        {d.parse.warning_counts?.length > 0 && (
          <ul className="space-y-0.5 text-[10px] text-amber-200/90">
            {d.parse.warning_counts.map((w) => (
              <li key={w.code}><span className="font-mono text-amber-300">{w.code}</span> ×{w.count} — {w.message}</li>
            ))}
          </ul>
        )}
        <div className="border-t border-neutral-800 pt-2 font-mono text-[10px] text-neutral-400">
          facts: <span className="text-emerald-300">{d.facts.accepted} accepted</span> · {d.facts.skipped_total ?? "—"} skipped · {d.facts.unclassified_numbers ?? "—"} unclassified
          {d.facts.zero_fact_reason && <div className="mt-1 font-sans text-neutral-300">{d.facts.zero_fact_reason}</div>}
        </div>
      </div>
    ))}
  </div>
);

type Pair = { a: string; b: string } | null;

const RelatednessMatrix: React.FC<{ report: ReasoningReport; selected: Pair; onSelect: (p: Pair) => void }> = ({ report, selected, onSelect }) => {
  const docs = report.documents;
  const cell = (a: string, b: string) =>
    report.relatedness.find((r) => (r.source_a === a && r.source_b === b) || (r.source_a === b && r.source_b === a));
  if (docs.length < 2) return null;
  const isSel = (a: string, b: string) => !!selected && ((selected.a === a && selected.b === b) || (selected.a === b && selected.b === a));
  return (
    <div className="space-y-1">
      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="text-[11px]">
          <thead className="bg-neutral-900/80 text-neutral-500">
            <tr>
              <th className="px-3 py-2" />
              {docs.map((d) => <th key={d.source_id} className="px-3 py-2 text-left font-medium">{d.filename}</th>)}
            </tr>
          </thead>
          <tbody>
            {docs.map((row, ri) => (
              <tr key={row.source_id} className="border-t border-neutral-800 align-top">
                <th className="px-3 py-2 text-left font-medium text-neutral-300">{row.filename}</th>
                {docs.map((col, ci) => {
                  if (ci <= ri) return <td key={col.source_id} className="px-3 py-2 text-neutral-700">{ci === ri ? "—" : ""}</td>;
                  const c = cell(row.source_id, col.source_id);
                  if (!c) return <td key={col.source_id} className="px-3 py-2">{NOT_PROVIDED}</td>;
                  const sel = isSel(row.source_id, col.source_id);
                  return (
                    <td key={col.source_id} className="min-w-[240px] max-w-[320px] px-1 py-1">
                      <button
                        type="button"
                        onClick={() => onSelect(sel ? null : { a: row.source_id, b: col.source_id })}
                        className={`w-full space-y-1 rounded p-2 text-left hover:bg-neutral-800/60 ${sel ? "ring-1 ring-sky-500 bg-sky-500/5" : ""}`}
                        aria-pressed={sel}
                        title="Click to filter comparisons to this pair"
                      >
                        <div className="flex flex-wrap items-center gap-2 text-[10px] text-neutral-400">
                          topic similarity{" "}
                          <span className="font-mono text-neutral-100" title={c.topic_similarity?.method}>
                            {c.topic_similarity ? (c.topic_similarity.value == null ? "not scored" : c.topic_similarity.value.toFixed(2)) : "not provided"}
                          </span>
                          · signals <span className="font-mono text-neutral-100">{c.score == null ? "not scored" : `${Math.round(c.score * c.signals.length)}/${c.signals.length}`}</span>
                        </div>
                        <ul className="space-y-0.5 text-[10px]">
                          {c.signals.map((sg) => (
                            <li key={sg.name} className={sg.matched ? "text-emerald-300" : "text-neutral-500"}>
                              {sg.matched ? "✓" : "✗"} {sg.name}{sg.matched ? `: ${sg.detail}` : ""}
                            </li>
                          ))}
                        </ul>
                        {c.relation_summary && <p className="text-[10px] text-neutral-300">{c.relation_summary}</p>}
                        {!c.relation_summary && c.reason && <p className="text-[10px] text-neutral-500">{c.reason}</p>}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && (
        <button type="button" onClick={() => onSelect(null)} className="text-[10px] text-sky-300 underline">
          Showing comparisons for the selected pair only. Show all
        </button>
      )}
    </div>
  );
};

const PairFunnel: React.FC<{ stages: FunnelStage[] }> = ({ stages }) => (
  <ol className="relative space-y-0 border-l border-neutral-700 pl-5">
    {stages.map((st, i) => (
      <li key={i} className="relative pb-3">
        <span className={`absolute -left-[27px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold ${st.count ? "bg-sky-600 text-white" : "bg-neutral-700 text-neutral-300"}`}>
          {i + 1}
        </span>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-sm text-neutral-100">{st.count}</span>
          <span className="text-[10px] uppercase text-neutral-500">{st.unit}</span>
          <span className="text-[11px] text-neutral-300">{st.stage}</span>
        </div>
        {st.note && <div className="text-[10px] text-neutral-500">{st.note}</div>}
        {!!st.dropped && (
          <details className="mt-0.5">
            <summary className="cursor-pointer text-[10px] text-amber-300">
              − {st.dropped} dropped: <span className="font-mono">{st.reason_code}</span>
            </summary>
            {st.example_ids && st.example_ids.length > 0 && (
              <div className="mt-1 font-mono text-[9px] text-neutral-500">
                examples: {st.example_ids.map((x) => (Array.isArray(x) ? x.join(" + ") : String(x))).join(" · ")}
              </div>
            )}
          </details>
        )}
      </li>
    ))}
  </ol>
);

const AttributeOverlapTable: React.FC<{ report: ReasoningReport }> = ({ report }) => {
  const rows = report.attribute_overlap ?? [];
  if (!rows.length) return <p className="text-[11px] text-neutral-500">No attributes: no facts were accepted.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left text-[11px]">
        <thead className="bg-neutral-900/80 text-neutral-500">
          <tr>
            <th className="px-3 py-2 font-medium">Attribute</th>
            <th className="px-3 py-2 font-medium">Entities</th>
            {report.documents.map((d) => <th key={d.source_id} className="px-3 py-2 font-medium">{d.filename}</th>)}
            <th className="px-3 py-2 font-medium">Pairable?</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.attribute_normalized} className="border-t border-neutral-800 text-neutral-300">
              <td className="px-3 py-1.5 font-medium text-neutral-100">{a.attribute_normalized}</td>
              <td className="px-3 py-1.5 text-[10px]">{a.entities.join(", ")}</td>
              {report.documents.map((d) => {
                const hit = a.documents.find((x) => x.source_id === d.source_id);
                return <td key={d.source_id} className="px-3 py-1.5 font-mono text-[10px]">{hit ? `✓ ${hit.fact_ids.length}` : <span className="text-neutral-700">—</span>}</td>;
              })}
              <td className="px-3 py-1.5 text-[10px]">
                {a.shared_across_documents ? <span className="text-emerald-300">in {a.documents.length} documents</span> : <span className="text-neutral-500">appears in 1 document only</span>}
                {a.unverified_fact_ids?.length ? <span className="ml-1 text-amber-300">({a.unverified_fact_ids.length} unverified)</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const NotComparableGroups: React.FC<{ report?: ReasoningReport; items: CaseNotComparable[] }> = ({ report, items }) => {
  const code = (nc: CaseNotComparable) => (nc.checks.find((c) => c.status === "fail")?.name || "unspecified").toUpperCase();
  const groups = report?.not_comparable_summary ?? [];
  if (!groups.length) return items.length ? <NotComparableList items={items} /> : null;
  return (
    <div className="space-y-1">
      {groups.map((g) => (
        <details key={g.reason_code} className="rounded border border-neutral-800 bg-neutral-900/50 px-3 py-2">
          <summary className="cursor-pointer text-[11px] text-neutral-200">
            <span className="font-mono text-amber-300">{g.reason_code}</span> — {g.count} pair{g.count === 1 ? "" : "s"}
            {g.example && <span className="text-neutral-500"> · e.g. {g.example}</span>}
          </summary>
          <div className="mt-2"><NotComparableList items={items.filter((n) => code(n) === g.reason_code)} /></div>
        </details>
      ))}
    </div>
  );
};

/* ------------------------------------------------------------------------------------------ section 4 */

const componentList = (c: ReasoningReport["case_score"]["components"] | undefined): ScoreComponent[] =>
  !c ? [] : Array.isArray(c) ? c : Object.entries(c).map(([name, value]) => ({ name, value }));

export const FinalResultCard: React.FC<{ analysis: CaseAnalysis }> = ({ analysis }) => {
  const rep = analysis.report;
  const cs = rep?.case_score;
  const legacy = !rep;
  // Older analyses reported 0 for "nothing to score"; that is shown as not scored, never 0%.
  const notScored = cs ? cs.status !== "scored"
    : analysis.final.confidence == null || ((analysis.final.comparisons ?? 0) === 0 && (analysis.final.findings ?? 0) === 0);
  const reasonText = cs?.reason_text || cs?.reason || analysis.final.not_scored_reason ||
    (legacy && notScored ? analysis.final.summary : undefined);
  const verdict = VERDICT[notScored ? "not_scored" : analysis.final.verdict] ?? VERDICT.failed;
  const counts = rep?.counts;
  const comps = componentList(cs?.components);
  return (
    <div className={`space-y-3 rounded-xl border p-5 ${verdict.tone}`}>
      {legacy && (
        <div className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[11px] text-sky-200">
          This analysis was made by an older version and has no reasoning report. Click “Re-run reasoning” to see the full trail.
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <verdict.Icon className="h-5 w-5 shrink-0" />
          <span className="text-base font-bold">{notScored ? "Not scored" : verdict.label}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-neutral-400">Case score</span>
          {notScored ? (
            <span className="rounded bg-neutral-800 px-2 py-1 font-mono text-xs text-neutral-200" title="not scored">—</span>
          ) : (
            <ConfidenceIndicator confidence={(cs?.value ?? analysis.final.confidence) as number} />
          )}
        </div>
      </div>
      <p className="text-sm text-neutral-200">
        {notScored ? (
          <>
            {cs?.reason_code && <span className="mr-1 font-mono text-[11px] text-neutral-400">{cs.reason_code}</span>}
            {reasonText || "no comparable pairs"}
          </>
        ) : (
          analysis.final.summary ?? analysis.final.error?.message
        )}
      </p>

      {!notScored && comps.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-neutral-700/60 bg-neutral-950/40 p-3">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Score breakdown</div>
          <table className="w-full text-left text-[10px]">
            <thead className="text-neutral-500">
              <tr><th className="py-1 pr-2">Component</th><th className="py-1 pr-2">Value</th><th className="py-1 pr-2">Weight</th><th className="py-1">How it was made</th></tr>
            </thead>
            <tbody>
              {comps.map((c, i) => (
                <tr key={i} className="border-t border-neutral-800 align-top text-neutral-300">
                  <td className="py-1 pr-2">{c.name}</td>
                  <td className="py-1 pr-2 font-mono">{c.value == null ? "not scored" : c.value.toFixed(2)}</td>
                  <td className="py-1 pr-2 font-mono">{c.weight == null ? "—" : c.weight.toFixed(2)}{c.weight_config_key ? ` (${c.weight_config_key})` : ""}</td>
                  <td className="py-1">{c.detail || "—"}{c.detail_config_key && <span className="font-mono text-neutral-500"> [{c.detail_config_key}]</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cs && <p className="flex items-start gap-1 text-[10px] text-neutral-400"><Sigma className="mt-0.5 h-3 w-3 shrink-0" /> Total = {cs.formula_description}</p>}
        </div>
      )}

      {counts ? (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Reconciliation</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-neutral-300">
            <span>documents {counts.documents}</span>
            <span>facts accepted {counts.facts_accepted}</span>
            <span>facts skipped {counts.facts_skipped}</span>
            {counts.attribute_groups !== undefined && <span>attribute groups {counts.attribute_groups}</span>}
            {counts.groups_shared !== undefined && <span>groups shared across documents {counts.groups_shared}</span>}
            <span>pairs considered {counts.pairs_considered}</span>
            <span>comparable {counts.comparable}</span>
            <span>not comparable {counts.not_comparable}</span>
            <span>findings {counts.findings}</span>
          </div>
          {rep?.reconciliation && (
            <ul className="space-y-0.5 text-[10px]">
              {rep.reconciliation.map((c) => (
                <li key={c.check} className={c.ok ? "text-emerald-300/80" : "font-semibold text-rose-300"}>
                  {c.ok ? "✓" : "⚠ DOES NOT RECONCILE:"} {c.check} ({c.detail})
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-4 text-[11px] text-neutral-300">
          <span>Documents: {analysis.final.documents ?? "—"}</span>
          <span>Facts: {analysis.final.facts ?? "—"}</span>
          <span>Comparisons: {analysis.final.comparisons ?? "—"}</span>
          <span>Findings: {analysis.final.findings ?? "—"}</span>
        </div>
      )}

      {(rep?.unlock_hints?.length ?? 0) > 0 ? (
        <div className="text-[11px] text-neutral-300">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">What would enable comparison</div>
          <ul className="list-disc pl-4">
            {rep!.unlock_hints!.map((h) => (
              <li key={h.reason_code + h.text}><span className="font-mono text-[10px] text-neutral-400">{h.reason_code}</span> {h.text}</li>
            ))}
          </ul>
        </div>
      ) : rep?.unlock?.length ? (
        <div className="text-[11px] text-neutral-300">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">What would enable comparison</div>
          <ul className="list-disc pl-4">{rep.unlock.map((u) => <li key={u}>{u}</li>)}</ul>
        </div>
      ) : null}
      <p className="text-[10px] text-neutral-500">
        Analyzed {formatBackendDate(analysis.analyzed_at)}{analysis.final.human_review_required ? " · manual review recommended" : ""} · no final decision has been made.
      </p>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------ layout */

type FactsOut = { facts: CaseFact[]; warnings: { code: string; message: string }[] };
type ReasoningOut = {
  comparisons: CaseComparison[];
  not_comparable: CaseNotComparable[];
  findings: CaseFinding[];
  warnings: { code: string; message: string }[];
};

const Sub: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-2">
    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{title}</h3>
    {children}
  </div>
);

export const AnalysisResult: React.FC<{
  analysis: CaseAnalysis;
  /** "top": final result first (Case Analysis page); "bottom": stages in pipeline order, final result last. */
  finalPosition?: "top" | "bottom";
  /** The batch page shows parsing itself, per document. */
  showParsing?: boolean;
  /** Number of the first stage shown. */
  firstStage?: number;
}> = ({ analysis, finalPosition = "top", showParsing = true, firstStage = 1 }) => {
  const parsing = stageOutput<SourceParseSummary[]>(analysis, "parsing") ?? [];
  const factsOut = stageOutput<FactsOut>(analysis, "fact_normalization");
  const union = stageOutput<UnionOut>(analysis, "union_parse");
  const excluded = analysis.stages.find((s) => s.stage === "parsing") as { excluded_sources?: { source_id: string; filename: string; reason: string }[] } | undefined;
  const reasoning = stageOutput<ReasoningOut>(analysis, "cross_document_reasoning");
  const facts = factsOut?.facts ?? [];
  const factsById = useMemo(() => new Map(facts.map((f) => [f.fact_id, f])), [facts]);
  const stageStatus = (name: string) => analysis.stages.find((s) => s.stage === name);
  const rep = analysis.report;
  const [showFactWarnings, setShowFactWarnings] = useState(false);
  const [pair, setPair] = useState<Pair>(null);
  const srcOf = (id: string) => factsById.get(id)?.evidence[0]?.source_id;
  const inPair = (ids: string[]) => {
    if (!pair) return true;
    const s = new Set(ids.map(srcOf));
    return s.has(pair.a) && s.has(pair.b);
  };
  let n = firstStage;

  return (
    <div className="space-y-6">
      {finalPosition === "top" && <FinalResultCard analysis={analysis} />}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {showParsing && (
            <section className="space-y-2">
              <SectionTitle n={n++} title="Parsing output per document" agents="01–04, 08" status={stageStatus("parsing")?.status} />
              <ParsingStage sources={parsing} />
            </section>
          )}

          {union && (
            <section className="space-y-2">
              <SectionTitle n={n++} title="Final parse: union of all document parses" agents="01–04, 08" status="completed" />
              <UnionParse u={union} excluded={excluded?.excluded_sources} />
            </section>
          )}

          <section className="space-y-2">
            <SectionTitle n={n++} title="Normalized facts" agents="15" status={stageStatus("fact_normalization")?.status} />
            {stageStatus("fact_normalization")?.error && <ErrorAlert error={stageStatus("fact_normalization")!.error as never} />}
            <p className="text-[11px] text-neutral-500">
              A fact needs a label that names what it measures and a unit, currency, period, named party or key-value structure.
              Other numbers (matrix cells, formulas, pseudocode) are counted as unclassified, not facts.
            </p>
            {factsOut && <FactsByDocument facts={facts} report={rep} />}
            {factsOut?.warnings?.length ? (
              <button type="button" className="text-[10px] text-amber-300/80 underline" onClick={() => setShowFactWarnings((v) => !v)}>
                {showFactWarnings ? "Hide" : "Show"} {factsOut.warnings.length} normalizer warning(s)
              </button>
            ) : null}
            {showFactWarnings && (
              <ul className="text-[10px] text-amber-300/80">{factsOut?.warnings.map((w, i) => <li key={i}>{w.code}: {w.message}</li>)}</ul>
            )}
          </section>

          <section className="space-y-4">
            <SectionTitle n={n++} title="Cross-document reasoning" agents="16" status={stageStatus("cross_document_reasoning")?.status} />
            {stageStatus("cross_document_reasoning")?.error && <ErrorAlert error={stageStatus("cross_document_reasoning")!.error as never} />}
            {rep && (
              <Sub title="Inputs: parsing output and score of each document"><InputCards report={rep} /></Sub>
            )}
            {rep && rep.documents.length > 1 && (
              <Sub title="How related are the documents (click a cell to filter comparisons)">
                <RelatednessMatrix report={rep} selected={pair} onSelect={setPair} />
              </Sub>
            )}
            {rep?.funnel && (
              <Sub title="Pairing funnel: how facts became comparable pairs">
                <PairFunnel stages={rep.funnel} />
              </Sub>
            )}
            {rep?.attribute_overlap && (
              <Sub title="Attribute overlap: which documents report each attribute">
                <AttributeOverlapTable report={rep} />
              </Sub>
            )}
            {reasoning && (() => {
              const comps = reasoning.comparisons.filter((c) => inPair(c.fact_ids));
              const ncs = reasoning.not_comparable.filter((n) => inPair(n.fact_ids));
              return (
                <>
                  <Sub title={`Comparisons (${comps.length} comparable of ${pair ? comps.length + ncs.length : rep?.counts.pairs_considered ?? comps.length + ncs.length} considered${pair ? ", selected pair" : ""})`}>
                    {comps.length ? (
                      <ComparisonsTable comparisons={comps} factsById={factsById} />
                    ) : (
                      <div className="space-y-1 rounded border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-[11px] text-neutral-300">
                        <p>
                          No comparable pairs{rep ? ` (${rep.counts.pairs_considered} considered, ${rep.counts.not_comparable} rejected)` : ""}. Why:
                        </p>
                        {rep?.unlock_hints?.length ? (
                          <ul className="list-disc pl-4">
                            {rep.unlock_hints.map((h) => <li key={h.reason_code + h.text}><span className="font-mono text-[10px] text-amber-300">{h.reason_code}</span> {h.text}</li>)}
                          </ul>
                        ) : (
                          <p className="text-neutral-500">{rep?.no_pairs_reason || "reason not provided by backend (re-run the analysis)"}</p>
                        )}
                        {rep?.funnel && <p className="text-[10px] text-neutral-500">See the pairing funnel above for where the facts dropped out.</p>}
                      </div>
                    )}
                  </Sub>
                  {ncs.length > 0 && (
                    <Sub title={`Not comparable (${ncs.length})`}>
                      {pair ? <NotComparableList items={ncs} /> : <NotComparableGroups report={rep} items={ncs} />}
                    </Sub>
                  )}
                  {rep?.dropped_by_reasoning.length ? (
                    <p className="text-[10px] text-amber-300/80">
                      Facts dropped before comparison: {rep.dropped_by_reasoning.map((d) => `${d.code} ×${d.count}`).join(", ")}
                    </p>
                  ) : null}
                  {reasoning.findings.length > 0 && (
                    <Sub title={`Findings (${reasoning.findings.length})`}>
                      {reasoning.findings.filter((f) => !pair || comps.some((c) => c.comparison_id === f.comparison_id)).map((f) => <FindingCard key={f.finding_id} f={f} />)}
                    </Sub>
                  )}
                </>
              );
            })()}
          </section>

          {finalPosition === "bottom" && (
            <section className="space-y-2">
              <SectionTitle n={n++} title="Final output" agents="15 + 16" status={analysis.final.verdict === "failed" ? "failed" : "completed"} />
              <FinalResultCard analysis={analysis} />
            </section>
          )}
        </div>
        <aside className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Evidence on the page</h3>
          <p className="text-[10px] text-neutral-500">Hover a fact, comparison or finding to see where it comes from.</p>
          <HighlightedPagesPreview />
        </aside>
      </div>
    </div>
  );
};
