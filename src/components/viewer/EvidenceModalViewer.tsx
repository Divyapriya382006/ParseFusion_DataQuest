import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useEvidence } from "../../context/EvidenceContext";
import { getSourcePage } from "../../api/sources";
import { Modal } from "../common/Modal";
import { SourceViewer } from "./SourceViewer";
import { BackendNotConnected } from "../common/BackendNotConnected";
import { Skeleton } from "../common/LoadingSkeleton";
import { ExternalLink } from "lucide-react";

export const EvidenceModalViewer: React.FC = () => {
  const { activeEvidence, isModalOpen, closeEvidence } = useEvidence();

  const sourceId = activeEvidence?.source_id;
  const pageNumber = activeEvidence?.page_number ?? 1;

  const { data: pageData, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["sourcePage", sourceId, pageNumber],
    queryFn: ({ signal }) => getSourcePage(sourceId!, pageNumber, signal),
    enabled: isModalOpen && Boolean(sourceId),
    retry: 1,
  });

  if (!isModalOpen || !activeEvidence) return null;

  return (
    <Modal
      isOpen={isModalOpen}
      onClose={closeEvidence}
      title={`Evidence Anchor: ${activeEvidence.filename || activeEvidence.source_id} (Page ${pageNumber})`}
      maxWidth="6xl"
    >
      <div className="flex flex-col h-[75vh]">
        {/* Evidence Metadata Bar */}
        <div className="p-3 bg-neutral-950/70 border border-neutral-800 rounded-lg mb-3 flex items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-neutral-300">Excerpt:</span>
            <span className="font-mono text-neutral-200 truncate max-w-md">
              "{activeEvidence.text_excerpt}"
            </span>
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px] text-neutral-400 shrink-0">
            <span>Block: {activeEvidence.block_id}</span>
            <span>Confidence: {Math.round(activeEvidence.confidence * 100)}%</span>
            <a
              href={`/sources/${activeEvidence.source_id}`}
              className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300"
            >
              Document View
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>

        {/* Viewer Area */}
        <div className="flex-1 min-h-0">
          {isLoading && (
            <div className="h-full flex items-center justify-center p-8 bg-neutral-950/60 rounded-xl">
              <Skeleton className="w-full h-full max-w-2xl bg-neutral-800/40" />
            </div>
          )}

          {isError && (
            <BackendNotConnected
              endpoint={`/sources/${sourceId}/pages/${pageNumber}`}
              onRetry={() => refetch()}
              message="Could not load the page image and bounding box layers from the backend."
            />
          )}

          {pageData && (
            <SourceViewer
              page={pageData}
              currentPageNumber={pageNumber}
              highlightedBbox={activeEvidence.bbox}
            />
          )}
        </div>
      </div>
    </Modal>
  );
};
