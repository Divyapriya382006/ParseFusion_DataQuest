import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw, CheckCircle2, XCircle, Play, Server } from "lucide-react";
import { fetchAgentHealth } from "../api/health";
import { ALL_AGENTS } from "../agents/index";
import { apiClient } from "../api/client";
import { BackendNotConnected } from "../components/common/BackendNotConnected";
import { Skeleton } from "../components/common/LoadingSkeleton";

interface AgentCheckResult {
  endpoint: string;
  connected: boolean;
  error?: string;
}

export const AgentStatusPage: React.FC = () => {
  const { data: healthData, isLoading, isError, refetch } = useQuery({
    queryKey: ["agentHealth"],
    queryFn: ({ signal }) => fetchAgentHealth(signal),
    retry: 1,
  });

  const [contractResults, setContractResults] = useState<Record<string, AgentCheckResult>>({});
  const [isRunningCheck, setIsRunningCheck] = useState<boolean>(false);

  // Ping each agent route to verify backend wiring
  const runContractCheck = async () => {
    setIsRunningCheck(true);
    const results: Record<string, AgentCheckResult> = {};

    for (const agent of ALL_AGENTS) {
      try {
        await apiClient(agent.endpoint, {
          method: agent.method === "POST" ? "POST" : "GET",
          body: agent.method === "POST" ? {} : undefined,
        });
        results[agent.id] = { endpoint: agent.endpoint, connected: true };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        // Even if validation error (e.g., 400 Bad Request because empty body),
        // that means endpoint is connected and responding!
        if (msg.includes("404") || msg.includes("Backend not connected") || msg.includes("failed to fetch")) {
          results[agent.id] = { endpoint: agent.endpoint, connected: false, error: msg };
        } else {
          results[agent.id] = { endpoint: agent.endpoint, connected: true, error: msg };
        }
      }
      setContractResults({ ...results });
    }

    setIsRunningCheck(false);
  };

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-neutral-100 flex items-center gap-2">
            <Activity className="w-5 h-5 text-sky-400" />
            <span>Agent Status & Backend Contract Verification</span>
          </h1>
          <p className="text-xs text-neutral-400 mt-1">
            Real-time health of all 24 specialized backend agents and automated contract ping checks.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 text-neutral-300 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh Health</span>
          </button>

          <button
            type="button"
            onClick={runContractCheck}
            disabled={isRunningCheck}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium shadow transition-colors disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{isRunningCheck ? "Testing 24 Agents..." : "Run Contract Check"}</span>
          </button>
        </div>
      </div>

      {isError && (
        <BackendNotConnected
          endpoint="/health/agents"
          onRetry={() => refetch()}
          message="Could not reach the system health telemetry endpoint. Run the contract check below to inspect individual agent routes."
        />
      )}

      {/* Agents Health & Wiring Grid */}
      <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
          <span className="font-semibold text-neutral-200">
            Specialized Agent Fleet ({ALL_AGENTS.length} registered agents)
          </span>
          <span className="text-neutral-500 font-mono text-[11px]">
            Target Base URL: {import.meta.env.VITE_API_BASE_URL || "<unset>"}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[11px] text-left">
            <thead>
              <tr className="bg-neutral-950/80 border-b border-neutral-800 text-neutral-400">
                <th className="p-3">Agent</th>
                <th className="p-3">Route Endpoint</th>
                <th className="p-3">Health Status</th>
                <th className="p-3">Contract Check Status</th>
              </tr>
            </thead>
            <tbody>
              {ALL_AGENTS.map((agent) => {
                const health = healthData?.agents?.find((a) => a.id === agent.id);
                const check = contractResults[agent.id];

                return (
                  <tr
                    key={agent.id}
                    className="border-b border-neutral-800/40 hover:bg-neutral-800/20 text-neutral-300"
                  >
                    <td className="p-3 font-semibold text-neutral-200 font-sans">
                      {agent.name}
                    </td>
                    <td className="p-3 text-neutral-400">
                      <span className="text-neutral-500 mr-1.5">{agent.method}</span>
                      {agent.endpoint}
                    </td>
                    <td className="p-3">
                      {health ? (
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${
                            health.status === "healthy"
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                              : "bg-amber-500/10 text-amber-300 border border-amber-500/20"
                          }`}
                        >
                          {health.status} {health.latency_ms && `(${health.latency_ms}ms)`}
                        </span>
                      ) : (
                        <span className="text-neutral-500 text-[10px]">Awaiting telemetry</span>
                      )}
                    </td>
                    <td className="p-3">
                      {check ? (
                        check.connected ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Connected</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-rose-400" title={check.error}>
                            <XCircle className="w-3.5 h-3.5" />
                            <span>Not connected</span>
                          </span>
                        )
                      ) : (
                        <span className="text-neutral-600">Pending ping check</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
