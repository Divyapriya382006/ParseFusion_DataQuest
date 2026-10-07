import React, { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileCheck, AlertCircle } from "lucide-react";
import { submitHumanApproval } from "../agents/18_humanApproval";
import { apiClient } from "../api/client";
import type { ProposedAction } from "../types/canonical";
import type { ApprovalEvent, ApprovalSignature } from "../agents/18_humanApproval";
import { ActionDraftCard } from "../components/actions/ActionDraftCard";
import { ActionTimeline } from "../components/actions/ActionTimeline";
import { BackendNotConnected } from "../components/common/BackendNotConnected";
import { Skeleton } from "../components/common/LoadingSkeleton";

export const ActionsPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const requestedActionId = searchParams.get("action_id") || "";

  // List recent actions or fetch specific action
  const {
    data: actionData,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["actionDetails", requestedActionId],
    queryFn: async ({ signal }) => {
      if (!requestedActionId) {
        const list = await apiClient<{ actions: ProposedAction[] }>("/actions", { signal });
        return { action: list.actions?.[0], events: [], signature: undefined };
      }
      return apiClient<{
        action: ProposedAction;
        events: ApprovalEvent[];
        signature?: ApprovalSignature;
      }>(`/actions/${requestedActionId}`, { signal });
    },
    enabled: true,
  });

  const [isUpdating, setIsUpdating] = useState(false);

  const handleDecision = async (
    decision: "save_edit" | "submit_review" | "approve" | "reject" | "cancel" | "execute",
    notes?: string,
    editedFields?: Record<string, unknown>,
    rejectionReason?: string
  ) => {
    if (!actionData?.action?.action_id) return;
    try {
      setIsUpdating(true);
      await submitHumanApproval({
        action_id: actionData.action.action_id,
        decision,
        notes,
        edited_fields: editedFields,
        rejection_reason: rejectionReason,
      });
      // Immediately refetch from backend (Rule 5: Frontend never computes business results or approval validity)
      await refetch();
    } finally {
      setIsUpdating(false);
    }
  };

  if (isError) {
    return (
      <div className="p-8 max-w-4xl mx-auto space-y-4">
        <h1 className="text-xl font-bold text-neutral-100">Governed Action Review</h1>
        <BackendNotConnected
          endpoint={requestedActionId ? `/actions/${requestedActionId}` : "/actions"}
          onRetry={() => refetch()}
          message="Could not retrieve the proposed action draft from the backend."
        />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 text-xs">
      <div>
        <h1 className="text-xl font-bold text-neutral-100 flex items-center gap-2">
          <FileCheck className="w-5 h-5 text-sky-400" />
          <span>Governed Action Review & Approval</span>
        </h1>
        <p className="text-xs text-neutral-400 mt-1">
          Review, revise, approve, or reject automated action proposals before dispatch.
        </p>
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      )}

      {actionData?.action ? (
        <div className="space-y-6">
          <ActionDraftCard
            action={actionData.action}
            onDecision={handleDecision}
            isUpdating={isUpdating}
          />

          <ActionTimeline
            events={actionData.events}
            signature={actionData.signature}
          />
        </div>
      ) : !isLoading ? (
        <div className="p-8 text-center text-neutral-500 bg-neutral-900/40 border border-neutral-800 rounded-xl">
          No proposed actions pending human review.
        </div>
      ) : null}
    </div>
  );
};
