import React, { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import { getSourceDocument } from "../../api/sources";
import { getApiUrl } from "../../api/client";
import { BarChartView, type ChartData } from "./BarChartView";

interface FoundChart {
  key: string;
  filename: string;
  page: number;
  title: string;
  insight: string;
  confidence: number;
  review: string[];
  cropUrl?: string;
  data: ChartData;
}

/** Lists every bar chart read from the selected document(s), redrawn from the extracted values. */
export const ChartPanel: React.FC<{ sourceIds: string[]; onAsk: (q: string) => void }> = ({ sourceIds, onAsk }) => {
  const [charts, setCharts] = useState<FoundChart[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all(sourceIds.map((id) => getSourceDocument(id).catch(() => null)))
      .then((docs) => {
        if (!live) return;
        const out: FoundChart[] = [];
        for (const d of docs) {
          if (!d) continue;
          for (const p of (d as any).pages ?? []) {
            for (const b of p.blocks ?? []) {
              if (b.type === "chart" && b.chart_data) {
                out.push({
                  key: `${d.source_id}:${b.block_id}`, filename: (d as any).filename, page: p.page_number,
                  title: b.title || b.caption || "Bar chart", insight: b.insight_text ?? "", confidence: b.confidence ?? 0,
                  review: b.review_reasons ?? [], cropUrl: b.crop_url ? getApiUrl(b.crop_url) : undefined, data: b.chart_data,
                });
              }
            }
          }
        }
        setCharts(out);
      })
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [sourceIds.join(",")]);

  if (loading) return <p className="text-xs text-neutral-500">Looking for charts…</p>;
  if (!charts.length) return <p className="text-xs text-neutral-500">No bar charts were found in the selected document(s).</p>;
  return (
    <div className="space-y-4" data-testid="chart-panel">
      <h2 className="text-sm font-semibold text-neutral-200 flex items-center gap-2"><BarChart3 className="w-4 h-4 text-sky-400" />Charts read from the document ({charts.length})</h2>
      {charts.map((c) => (
        <div key={c.key} className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 space-y-2">
          <div className="flex justify-between gap-2 text-xs">
            <span className="text-neutral-200 font-medium">{c.title}</span>
            <span className="text-neutral-500">{c.filename}, p.{c.page} · confidence {(c.confidence * 100).toFixed(0)}%</span>
          </div>
          <div className="flex flex-wrap gap-4">
            <BarChartView data={c.data} />
            {c.cropUrl && <img src={c.cropUrl} alt="original chart" className="max-h-56 rounded border border-neutral-800" />}
          </div>
          <div className="flex flex-wrap gap-3 text-[11px] text-neutral-400">
            {c.data.series.map((s) => (<span key={s.name} className="flex items-center gap-1"><i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />{s.name}</span>))}
          </div>
          <p className="text-xs text-neutral-400">{c.insight}</p>
          {c.review.length > 0 && <p className="text-xs text-amber-400">Needs review: {c.review.join("; ")}</p>}
          <button type="button" className="text-xs text-sky-400 hover:underline" onClick={() => onAsk(`What does the chart "${c.title}" on page ${c.page} show?`)}>
            Ask about this chart
          </button>
        </div>
      ))}
    </div>
  );
};
