import React from "react";
import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "./context/ThemeContext";
import { ConfigProvider } from "./context/ConfigContext";
import { AuthProvider } from "./context/AuthContext";
import { EvidenceProvider } from "./context/EvidenceContext";
import { EvidenceHighlightProvider } from "./context/EvidenceHighlightContext";
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
import { ExportsPage } from "./pages/ExportsPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { ChatPage } from "./pages/ChatPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const LegacyCaseAnalysisRedirect: React.FC = () => {
  const [searchParams] = useSearchParams();
  const nextParams = new URLSearchParams(searchParams);
  nextParams.set("view", "case-analysis");
  return <Navigate to={`/batch?${nextParams.toString()}`} replace />;
};

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ConfigProvider>
          <AuthProvider>
            <EvidenceProvider>
             <EvidenceHighlightProvider>
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
                        <Route path="/case-analysis" element={<LegacyCaseAnalysisRedirect />} />
                        <Route path="/actions" element={<ActionsPage />} />
                        <Route path="/access" element={<AccessControlPage />} />
                        <Route path="/exports" element={<ExportsPage />} />
                        <Route path="/audit" element={<AuditLogPage />} />
                        <Route path="/chat" element={<ChatPage />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                      </Routes>
                    </main>
                  </div>

                  {/* Global Click-to-Source Evidence Anchor Viewer Modal */}
                  <EvidenceModalViewer />
                </div>
              </BrowserRouter>
             </EvidenceHighlightProvider>
            </EvidenceProvider>
          </AuthProvider>
        </ConfigProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}