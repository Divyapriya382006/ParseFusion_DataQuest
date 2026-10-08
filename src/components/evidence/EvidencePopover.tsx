import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { getSourcePage } from "../../api/sources";
import type { EvidenceReference, PageUnit } from "../../types/canonical";
import { computePopoverPosition, isRestricted, isValidBbox } from "../../lib/evidence";
import type { PopoverPosition } from "../../lib/evidence";
import { EvidenceThumbnail } from "./EvidenceThumbnail";

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface EvidencePopoverProps {
  id: string;
  evidence: EvidenceReference;
  anchorRect: AnchorRect;
  /** Page data the caller already has. When given, nothing is fetched. */
  pageData?: PageUnit;
  onActivate: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

/** True when the popover needs page data the evidence itself does not carry. */
export function needsPageData(evidence: EvidenceReference, pageData?: PageUnit): boolean {
  if (isRestricted(evidence) || pageData) return false;
  const selfSufficient =
    Boolean(evidence.crop_url) && Boolean(evidence.extraction_method);
  return !selfSufficient;
}

const POPOVER_WIDTH = 288;

export const EvidencePopover: React.FC<EvidencePopoverProps> = ({
  id,
  evidence,
  anchorRect,
  pageData,
  onActivate,
  onPointerEnter,
  onPointerLeave,
}) => {
  const restricted = isRestricted(evidence);
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  const fetchPage = needsPageData(evidence, pageData);
  const { data: fetchedPage, isError } = useQuery({
    queryKey: ["sourcePage", evidence.source_id, evidence.page_number],
    queryFn: ({ signal }) => getSourcePage(evidence.source_id, evidence.page_number, signal),
    enabled: fetchPage,
    staleTime: Infinity,
    retry: 0,
  });
  const page = pageData ?? fetchedPage;
  const block = page?.blocks?.find((b) => b.block_id === evidence.block_id);

  const method = evidence.extraction_method ?? block?.extraction_method;
  const unavailableReason = evidence.bbox_unavailable_reason ?? block?.location?.bbox_unavailable_reason;
  const bbox = isValidBbox(evidence.bbox) ? evidence.bbox : null;

  // Position after the content is measured; re-run when the content changes size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition(
      computePopoverPosition(
        anchorRect,
        { width: rect.width || POPOVER_WIDTH, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight }
      )
    );
  }, [anchorRect, page, restricted]);

  const pageWidth = evidence.page_width ?? page?.width;
  const pageHeight = evidence.page_height ?? page?.height;

  let preview: React.ReactNode = null;
  if (!restricted) {
    if (evidence.crop_url) {
      preview = (
        <img
          data-testid="evidence-crop"
          src={evidence.crop_url}
          alt="Source region"
          loading="lazy"
          referrerPolicy="no-referrer"
          className="max-w-full rounded border border-neutral-700"
          style={{ maxHeight: 144 }}
        />
      );
    } else if (page && pageWidth && pageHeight) {
      preview = (
        <EvidenceThumbnail
          imageUrl={page.image_url}
          pageKey={evidence.page_id ?? page.page_id ?? `${evidence.source_id}:${evidence.page_number}`}
          pageWidth={pageWidth}
          pageHeight={pageHeight}
          bbox={bbox}
        />
      );
    } else if (isError) {
      preview = <div className="text-[11px] text-neutral-500">Preview unavailable</div>;
    } else if (fetchPage) {
      preview = <div className="text-[11px] text-neutral-500">Loading preview…</div>;
    }
  }

  const content = (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      data-testid="evidence-popover"
      onClick={restricted ? undefined : onActivate}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={`fixed z-[70] rounded-lg border border-neutral-700 bg-neutral-900 p-3 text-xs text-neutral-200 shadow-2xl space-y-2 ${
        restricted ? "" : "cursor-pointer"
      }`}
      style={{
        width: POPOVER_WIDTH,
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {restricted ? (
        <div className="flex items-center gap-2 text-amber-300" data-testid="evidence-restricted">
          <Lock className="w-3.5 h-3.5 shrink-0" />
          <span>Restricted — this value is withheld by access policy.</span>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <span className="font-semibold text-neutral-100 break-all">
              {evidence.filename || evidence.source_id}
            </span>
            <span className="font-mono text-[11px] text-neutral-400 shrink-0">Page {evidence.page_number}</span>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
            <dt className="text-neutral-500">Method</dt>
            <dd className="text-neutral-200 truncate">{method ?? "—"}</dd>
            <dt className="text-neutral-500">Confidence</dt>
            <dd className="text-neutral-200">{String(evidence.confidence)}</dd>
          </dl>

          {evidence.text_excerpt && (
            <p
              data-testid="evidence-excerpt"
              className="font-mono text-[11px] text-neutral-300 bg-neutral-950/70 border border-neutral-800 rounded p-1.5 break-words"
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {evidence.text_excerpt}
            </p>
          )}

          {preview}

          {!bbox && unavailableReason && (
            <p data-testid="evidence-bbox-note" className="text-[11px] text-amber-300">
              {unavailableReason}
            </p>
          )}
        </>
      )}
    </div>
  );

  return createPortal(content, document.body);
};
