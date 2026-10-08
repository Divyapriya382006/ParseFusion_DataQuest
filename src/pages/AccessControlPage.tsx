import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, Eye, KeyRound } from "lucide-react";
import {
  fetchAccessSchema,
  fetchAccessPreview,
  submitAccessRequest,
  fetchAccessRequests,
  decideAccessRequest,
} from "../agents/23_accessControl";
import { SchemaBrowser } from "../components/access/SchemaBrowser";
import { AccessRequestsQueue } from "../components/access/AccessRequestsQueue";
import { DocumentAccessPanel } from "../components/access/DocumentAccessPanel";
import { RequestAccessModal } from "../components/access/RequestAccessModal";
import { BackendNotConnected } from "../components/common/BackendNotConnected";
import { LockedCell } from "../components/common/LockedCell";
import { Skeleton } from "../components/common/LoadingSkeleton";
import { Modal } from "../components/common/Modal";
import { useAuth } from "../context/AuthContext";
import { CAPABILITY_KEYS } from "../config/capabilityKeys";
import { BackendApiError } from "../api/errors";

export const AccessControlPage: React.FC = () => {
  const { hasCapability } = useAuth();
  const canAdmin = hasCapability(CAPABILITY_KEYS.ACCESS_ADMIN);

  const [activeTab, setActiveTab] = useState<"catalog" | "queue" | "documents">("documents");

  // Schema Catalog
  const {
    data: schemaData,
    isLoading: isSchemaLoading,
    isError: isSchemaError,
    error: schemaError,
    refetch: refetchSchema,
  } = useQuery({
    queryKey: ["accessSchema"],
    queryFn: ({ signal }) => fetchAccessSchema(signal),
  });

  // Admin Elevation Requests
  const {
    data: requestsData,
    isLoading: isRequestsLoading,
    refetch: refetchRequests,
  } = useQuery({
    queryKey: ["accessRequests"],
    queryFn: ({ signal }) => fetchAccessRequests(signal),
    enabled: canAdmin,
  });

  // Request Access Modal State
  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    resourceId: string;
    tableName: string;
    columns?: string[];
  }>({
    isOpen: false,
    resourceId: "",
    tableName: "",
  });

  // Preview Modal State
  const [previewResourceId, setPreviewResourceId] = useState<string | null>(null);

  const { data: previewData, isLoading: isPreviewLoading } = useQuery({
    queryKey: ["accessPreview", previewResourceId],
    queryFn: ({ signal }) =>
      fetchAccessPreview({ resource_id: previewResourceId! }, signal),
    enabled: Boolean(previewResourceId),
  });

  const handleOpenRequestModal = (
    resourceId: string,
    tableName: string,
    columns?: string[]
  ) => {
    setModalState({
      isOpen: true,
      resourceId,
      tableName,
      columns,
    });
  };

  const handleSubmitRequest = async (
    reason: string,
    duration?: string,
    columns?: string[]
  ) => {
    await submitAccessRequest({
      resource_id: modalState.resourceId,
      columns,
      reason,
      requested_duration: duration,
    });
    if (canAdmin) refetchRequests();
  };

  const handleAdminDecision = async (
    requestId: string,
    decision: "approve" | "reject",
    validUntil?: string,
    notes?: string
  ) => {
    await decideAccessRequest({
      request_id: requestId,
      decision,
      valid_until: validUntil,
      notes,
    });
    refetchRequests();
    refetchSchema();
  };

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 text-xs">
      <div>
        <h1 className="text-xl font-bold text-neutral-100 flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-amber-400" />
          <span>Document Access & Governance</span>
        </h1>
        <p className="text-xs text-neutral-400 mt-1">
          Catalog permissions, zero-knowledge locked columns, and auditable access elevation requests.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-neutral-800 pb-2">
        <button
          type="button"
          onClick={() => setActiveTab("catalog")}
          className={`px-4 py-2 rounded-lg font-medium text-xs transition-colors ${
            activeTab === "catalog"
              ? "bg-neutral-800 text-neutral-100 shadow-sm"
              : "text-neutral-400 hover:text-neutral-200"
          }`}
        >
          Catalog & Column Masking
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("documents")}
          className={`px-4 py-2 rounded-lg font-medium text-xs transition-colors ${
            activeTab === "documents"
              ? "bg-neutral-800 text-neutral-100 shadow-sm"
              : "text-neutral-400 hover:text-neutral-200"
          }`}
        >
          Documents & Requests
        </button>

        {canAdmin && (
          <button
            type="button"
            onClick={() => setActiveTab("queue")}
            className={`px-4 py-2 rounded-lg font-medium text-xs transition-colors ${
              activeTab === "queue"
                ? "bg-neutral-800 text-neutral-100 shadow-sm"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            Access Requests Queue ({requestsData?.requests?.length || 0})
          </button>
        )}
      </div>

      {activeTab === "catalog" && isSchemaError && (
        <BackendNotConnected
          endpoint="/agents/access/schema"
          onRetry={() => refetchSchema()}
          message="Could not load the catalog schema and column masking policies from the backend."
          detail={
            schemaError instanceof BackendApiError
              ? schemaError.message
              : schemaError instanceof Error
                ? schemaError.message
                : undefined
          }
        />
      )}

      {activeTab === "catalog" && isSchemaLoading && <Skeleton className="h-96 w-full rounded-xl" />}

      {activeTab === "catalog" && !isSchemaError && schemaData?.tables && (
        <SchemaBrowser
          tables={schemaData.tables}
          onPreviewTable={(id) => setPreviewResourceId(id)}
          onRequestAccess={(resId, name, cols) => handleOpenRequestModal(resId, name, cols)}
        />
      )}

      {activeTab === "documents" && <DocumentAccessPanel />}

      {activeTab === "queue" && canAdmin && (
        <AccessRequestsQueue
          requests={requestsData?.requests || []}
          onDecide={handleAdminDecision}
          isProcessing={isRequestsLoading}
        />
      )}

      {/* Request Access Modal */}
      <RequestAccessModal
        isOpen={modalState.isOpen}
        onClose={() => setModalState((prev) => ({ ...prev, isOpen: false }))}
        resourceId={modalState.resourceId}
        tableName={modalState.tableName}
        selectedColumns={modalState.columns}
        onSubmit={handleSubmitRequest}
      />

      {/* Governed Table Preview Modal */}
      <Modal
        isOpen={Boolean(previewResourceId)}
        onClose={() => setPreviewResourceId(null)}
        title={`Governed Schema Preview: ${previewResourceId}`}
        maxWidth="4xl"
      >
        <div className="space-y-4 text-xs">
          <div className="p-2.5 bg-neutral-950/70 border border-neutral-800 rounded-lg text-neutral-400">
            Previewing governed rows. Columns marked as restricted return null from the backend and are drawn with striped placeholders.
          </div>

          {isPreviewLoading && <Skeleton className="h-64 w-full rounded" />}

          {previewData && (
            <div className="overflow-x-auto border border-neutral-800 rounded-lg">
              <table className="w-full border-collapse font-mono text-[11px] text-left">
                <thead>
                  <tr className="bg-neutral-950 border-b border-neutral-800 text-neutral-400">
                    {previewData.columns?.map((col) => (
                      <th key={col.name} className="p-2.5">
                        {col.name} {col.locked && "(Locked)"}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewData.rows?.map((row, rIdx) => (
                    <tr
                      key={rIdx}
                      className="border-b border-neutral-800/40 hover:bg-neutral-800/20 text-neutral-300"
                    >
                      {row.map((val, cIdx) => {
                        const isLocked = previewData.columns?.[cIdx]?.locked;
                        return (
                          <td key={cIdx} className="p-2">
                            {isLocked ? (
                              <LockedCell compact label="Confidential" />
                            ) : (
                              String(val ?? "—")
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
};
