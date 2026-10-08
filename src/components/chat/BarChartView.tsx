import React from "react";

export interface ChartPoint { category: string | null; value: number | null; relative_size?: number | null }
export interface ChartSeriesData { name: string; color: string; points: ChartPoint[] }
export interface ChartData {
  title?: string | null;
  orientation: "vertical" | "horizontal";
  stacked: boolean;
  series: ChartSeriesData[];
  categories: (string | null)[];
  value_axis: { label?: string | null; calibrated: boolean };
  values_available: boolean;
  confidence: number;
}

const W = 520;
const H = 260;
const PAD = { l: 48, r: 12, t: 12, b: 36 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Re-draws a digitised bar chart from its extracted data (grouped or stacked, vertical or horizontal). */
export const BarChartView: React.FC<{ data: ChartData }> = ({ data }) => {
  const cats = data.categories.map((c) => c ?? "");
  const val = (p?: ChartPoint) => (p ? (data.values_available ? p.value ?? 0 : p.relative_size ?? 0) : 0);
  const at = (s: ChartSeriesData, c: string) => s.points.find((p) => (p.category ?? "") === c);
  const totals = cats.map((c) => data.series.reduce((a, s) => a + (data.stacked ? val(at(s, c)) : 0), 0));
  const maxV = data.stacked ? Math.max(...totals, 0) : Math.max(...data.series.flatMap((s) => s.points.map((p) => val(p))), 0);
  const top = niceMax(maxV);
  const horizontal = data.orientation === "horizontal";
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const bandLen = (horizontal ? ih : iw) / Math.max(1, cats.length);
  const per = data.stacked ? 1 : data.series.length;
  const barLen = (bandLen * 0.7) / per;
  const scale = (v: number) => (v / top) * (horizontal ? iw : ih);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-xl" role="img" aria-label={data.title ?? "bar chart"}>
      {ticks.map((t, i) => {
        const p = horizontal ? PAD.l + scale(t) : PAD.t + ih - scale(t);
        return (
          <g key={i}>
            {horizontal ? <line x1={p} x2={p} y1={PAD.t} y2={PAD.t + ih} stroke="#404040" strokeDasharray="2 3" />
              : <line x1={PAD.l} x2={PAD.l + iw} y1={p} y2={p} stroke="#404040" strokeDasharray="2 3" />}
            <text x={horizontal ? p : PAD.l - 6} y={horizontal ? PAD.t + ih + 14 : p + 3} textAnchor={horizontal ? "middle" : "end"} fontSize="9" fill="#a3a3a3">
              {data.values_available ? +t.toPrecision(3) : `${Math.round((t / top) * 100)}%`}
            </text>
          </g>
        );
      })}
      {cats.map((c, ci) => {
        const band = (horizontal ? PAD.t : PAD.l) + ci * bandLen + bandLen * 0.15;
        let acc = 0;
        return (
          <g key={ci}>
            {data.series.map((s, si) => {
              const v = val(at(s, c));
              const off = data.stacked ? 0 : si * barLen;
              const len = scale(v);
              const start = data.stacked ? acc : 0;
              if (data.stacked) acc += v;
              const x = horizontal ? PAD.l + scale(start) : band + off;
              const y = horizontal ? band + off : PAD.t + ih - scale(start) - len;
              const w = horizontal ? len : barLen;
              const h = horizontal ? barLen : len;
              return (
                <g key={si}>
                  <rect x={x} y={y} width={Math.max(0, w)} height={Math.max(0, h)} fill={s.color} rx="1">
                    <title>{`${s.name} · ${c}: ${data.values_available ? v : `${Math.round(v * 100)}% of largest`}`}</title>
                  </rect>
                  {data.values_available && !data.stacked && (
                    <text x={horizontal ? x + w + 3 : x + w / 2} y={horizontal ? y + h / 2 + 3 : y - 3} textAnchor={horizontal ? "start" : "middle"} fontSize="8" fill="#d4d4d4">{v}</text>
                  )}
                </g>
              );
            })}
            <text x={horizontal ? PAD.l - 6 : band + (bandLen * 0.7) / 2} y={horizontal ? band + (bandLen * 0.7) / 2 + 3 : PAD.t + ih + 14}
              textAnchor={horizontal ? "end" : "middle"} fontSize="9" fill="#d4d4d4">{c}</text>
          </g>
        );
      })}
      <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={PAD.t + ih} stroke="#737373" />
      <line x1={PAD.l} x2={PAD.l + iw} y1={PAD.t + ih} y2={PAD.t + ih} stroke="#737373" />
    </svg>
  );
};
