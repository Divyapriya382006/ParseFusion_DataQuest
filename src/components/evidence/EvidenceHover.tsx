import React from "react";
import type { EvidenceReference, PageUnit } from "../../types/canonical";
import { isRestricted } from "../../lib/evidence";
import { useEvidenceHover } from "./useEvidenceHover";

interface EvidenceHoverProps {
  /** The evidence behind the wrapped value. When missing, the children render untouched. */
  evidence: EvidenceReference | null | undefined;
  children: React.ReactNode;
  as?: "span" | "div";
  className?: string;
  /**
   * Makes the wrapper a keyboard stop (focus opens the popover, Enter opens the source).
   * Turn off when the children are already focusable, e.g. a button: focus on the child bubbles up and still works.
   */
  focusable?: boolean;
  /** Click opens the source. Turn off when the child already handles its own click. */
  openOnClick?: boolean;
  /** Replaces the default "open the full Source Viewer". */
  onActivate?: () => void;
  pageData?: PageUnit;
  highlight?: boolean;
  delayMs?: number;
}

/**
 * Wraps any displayed value that has an EvidenceReference. Hover or keyboard focus shows a popover with the
 * source file, page, method, confidence, excerpt and a cropped thumbnail; click, Enter or a second touch tap
 * opens the Source Viewer on that page with the box highlighted.
 */
export const EvidenceHover: React.FC<EvidenceHoverProps> = ({
  evidence,
  children,
  as = "span",
  className,
  focusable = true,
  openOnClick = true,
  onActivate,
  pageData,
  highlight = true,
  delayMs,
}) => {
  const { anchorProps, popover } = useEvidenceHover({
    evidence,
    pageData,
    onActivate,
    openOnClick,
    highlight,
    delayMs,
  });

  if (!evidence) return <>{children}</>;

  const restricted = isRestricted(evidence);
  const Tag = as;
  return (
    <>
      <Tag
        {...anchorProps}
        className={className}
        tabIndex={focusable ? 0 : undefined}
        role={focusable && !restricted ? "button" : undefined}
        data-evidence-anchor="true"
        data-restricted={restricted ? "true" : undefined}
      >
        {children}
      </Tag>
      {popover}
    </>
  );
};
