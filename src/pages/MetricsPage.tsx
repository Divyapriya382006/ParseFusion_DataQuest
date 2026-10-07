import React from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, TrendingUp } from "lucide-react";
import { fetchMetrics } from "../api/metrics";
import { BackendNotConnected } from "../components/common/BackendNotConnected";
import { Skeleton } from "../components/common/LoadingSkeleton";
import { formatBackendNumber } from "../lib/formatters";

export const MetricsPage: React.FC = () => {
  const { data: metricsData, isLoading, isError, refetch } = useQuery({
    queryKey: ["systemMetrics"],
    queryFn: ({ signal }) => fetchMetrics(signal),
  });

  if (isError) {
    return (
      <div className="p-8 max-w-5xl mx-auto space-y-4">
        <h1 className="text-xl font-bold text-neutral-100">Quality & Pipeline Metrics</h1>
        <BackendNotConnected
          endpoint="/metrics"
          onRetry={() => refetch()}
          message="Could not load system quality and throughput metrics from the backend."
        />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 text-xs">
      <div>
        <h1 className="text-xl font-bold text-neutral-100 flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-sky-400" />
          <span>Quality & System Metrics</span>
        </h1>
        <p className="text-xs text-neutral-400 mt-1">
          Extraction precision, drift metrics, and pipeline throughput.
        </p>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      )}

      {metricsData?.items && metricsData.items.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {metricsData.items.map((metric) => (
            <div
              key={metric.id}
              className="p-5 bg-neutral-900/60 border border-neutral-800 rounded-xl space-y-3 flex flex-col justify-between"
            >
              <div>
                <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                  {metric.label}
                </div>
                <div className="mt-2 text-2xl font-bold font-mono text-neutral-100 tabular-nums">
                  {formatBackendNumber(metric.value, { unit: metric.unit })}
                </div>
              </div>

              {/* Generic SVG Sparkline if series is provided */}
              {metric.series && metric.series.length > 1 && (
                <div className="pt-2 border-t border-neutral-800/80">
                  <div className="flex items-center justify-between text-[10px] text-neutral-500 mb-1">
                    <span className="flex items-center gap-1">
                      <TrendingUp className="w-3 h-3 text-emerald-400" />
                      Trend History
                    </span>
                    <span>{metric.series.length} observations</span>
                  </div>
                  <div className="h-10 w-full">
                    {(() => {
                      const values = metric.series.map((s) => s.v);
                      const min = Math.min(...values);
                      const max = Math.max(...values);
                      const range = max - min || 1;
                      const points = metric.series
                        .map((s, idx) => {
                          const x = (idx / (metric.series!.length - 1)) * 100;
                          const y = 35 - ((s.v - min) / range) * 30;
                          return `${x},${y}`;
                        })
                        .join(" ");
                      return (
                        <svg viewBox="0 0 100 40" className="w-full h-full overflow-visible">
                          <polyline
                            fill="none"
                            stroke="#38bdf8"
                            strokeWidth="2"
                            points={points}
                          />
                        </svg>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : !isLoading ? (
        <div className="p-8 text-center text-neutral-500 bg-neutral-900/40 border border-neutral-800 rounded-xl">
          No metric telemetry items provided by backend.
        </div>
      ) : null}
    </div>
  );
};
