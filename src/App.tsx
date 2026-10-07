import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "./context/ThemeContext";
import { ConfigProvider } from "./context/ConfigContext";
import { AuthProvider } from "./context/AuthContext";
import { EvidenceProvider } from "./context/EvidenceContext";
import { TopBar } from "./components/common/TopBar";
import { Sidebar } from "./components/common/Sidebar";
import { EvidenceModalViewer } from "./components/viewer/EvidenceModalViewer";

// Pages
import { UploadPage } from "./pages/UploadPage";
import { BatchProgressPage } from "./pages/BatchProgressPage";
import { ResultsDashboardPage } from "./pages/ResultsDashboardPage";
import { CaseReviewPage } from "./pages/CaseReviewPage";
import { ActionsPage } from "./pages/ActionsPage";
import { AccessControlPage } from "./pages/AccessControlPage";
import { ChatPage } from "./pages/ChatPage";
import { ExportsPage } from "./pages/ExportsPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { MetricsPage } from "./pages/MetricsPage";
import { AgentStatusPage } from "./pages/AgentStatusPage";
import { SettingsPage } from "./pages/SettingsPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ConfigProvider>
          <AuthProvider>
            <EvidenceProvider>
              <BrowserRouter>
                <div className="flex flex-col h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100 font-sans selection:bg-sky-500/30 selection:text-white">
                  {/* Top Bar Contract (3 zones) */}
                  <TopBar />

                  <div className="flex flex-1 overflow-hidden min-h-0">
                    {/* Capability-governed Sidebar */}
                    <Sidebar />

                    {/* Main workspace scroll view */}
                    <main className="flex-1 overflow-y-auto min-w-0 bg-neutral-950/40">
                      <Routes>
                        <Route path="/" element={<UploadPage />} />
                        <Route path="/batch" element={<BatchProgressPage />} />
                        <Route path="/dashboard" element={<ResultsDashboardPage />} />
                        <Route path="/cases" element={<CaseReviewPage />} />
                        <Route path="/actions" element={<ActionsPage />} />
                        <Route path="/access" element={<AccessControlPage />} />
                        <Route path="/chat" element={<ChatPage />} />
                        <Route path="/exports" element={<ExportsPage />} />
                        <Route path="/audit" element={<AuditLogPage />} />
                        <Route path="/metrics" element={<MetricsPage />} />
                        <Route path="/agent-status" element={<AgentStatusPage />} />
                        <Route path="/settings" element={<SettingsPage />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                      </Routes>
                    </main>
                  </div>

                  {/* Global Click-to-Source Evidence Anchor Viewer Modal */}
                  <EvidenceModalViewer />
                </div>
              </BrowserRouter>
            </EvidenceProvider>
          </AuthProvider>
        </ConfigProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
