import React, { useEffect, useId } from "react";
import { useEvidenceHighlight } from "../../context/EvidenceHighlightContext";
import { toHighlightBoxes } from "../../lib/evidence";
import type { EvidenceReference } from "../../types/canonical";

interface HighlightScopeProps {
  /** All evidence of the fact / finding. Hovering or focusing the scope highlights every box at once. */
  evidences: readonly EvidenceReference[] | null | undefined;
  children: React.ReactNode;
  className?: string;
}

/**
 * Wraps a fact or finding card. While the card is hovered or has keyboard focus, all of its evidence boxes are
 * published for the page previews to draw, each labelled by its document.
 */
export const HighlightScope: React.FC<HighlightScopeProps> = ({ evidences, children, className }) => {
  const ownerId = `scope-${useId().replace(/:/g, "")}`;
  const { setOwnerBoxes, clearOwner } = useEvidenceHighlight();

  useEffect(() => () => clearOwner(ownerId), [clearOwner, ownerId]);

  const enter = () => {
    const boxes = toHighlightBoxes(evidences);
    if (boxes.length > 0) setOwnerBoxes(ownerId, boxes);
  };
  const leave = () => clearOwner(ownerId);

  return (
    <div
      className={className}
      data-highlight-scope="true"
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch") enter();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") leave();
      }}
      onFocus={enter}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) leave();
      }}
    >
      {children}
    </div>
  );
};
