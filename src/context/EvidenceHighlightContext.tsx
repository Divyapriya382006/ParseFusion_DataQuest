import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { HighlightBox } from "../lib/evidence";

/**
 * Shared "which boxes are being hovered right now" state.
 *
 * Anything that shows a value with evidence publishes its boxes here while it is hovered or focused. Anything that
 * shows a page image (Source Viewer, table page preview, case-review preview) reads the boxes for its page and draws
 * them. This is what makes highlighting two-way without the pieces knowing about each other.
 */
interface EvidenceHighlightContextType {
  boxes: HighlightBox[];
  setOwnerBoxes: (ownerId: string, boxes: HighlightBox[]) => void;
  clearOwner: (ownerId: string) => void;
}

const EvidenceHighlightContext = createContext<EvidenceHighlightContextType>({
  boxes: [],
  setOwnerBoxes: () => {},
  clearOwner: () => {},
});

export const EvidenceHighlightProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [byOwner, setByOwner] = useState<Record<string, HighlightBox[]>>({});

  const setOwnerBoxes = useCallback((ownerId: string, boxes: HighlightBox[]) => {
    setByOwner((prev) => ({ ...prev, [ownerId]: boxes }));
  }, []);

  const clearOwner = useCallback((ownerId: string) => {
    setByOwner((prev) => {
      if (!(ownerId in prev)) return prev;
      const next = { ...prev };
      delete next[ownerId];
      return next;
    });
  }, []);

  // Two owners can publish the same box (a card and the chip inside it): draw each box once.
  const boxes = useMemo(() => {
    const seen = new Set<string>();
    return Object.values(byOwner)
      .flat()
      .filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));
  }, [byOwner]);
  const value = useMemo(() => ({ boxes, setOwnerBoxes, clearOwner }), [boxes, setOwnerBoxes, clearOwner]);

  return <EvidenceHighlightContext.Provider value={value}>{children}</EvidenceHighlightContext.Provider>;
};

export function useEvidenceHighlight(): EvidenceHighlightContextType {
  return useContext(EvidenceHighlightContext);
}

/** Boxes currently highlighted on one page of one source. */
export function useBoxesForPage(sourceId: string | undefined, pageNumber: number | undefined): HighlightBox[] {
  const { boxes } = useEvidenceHighlight();
  return useMemo(
    () => boxes.filter((b) => b.source_id === sourceId && b.page_number === pageNumber),
    [boxes, sourceId, pageNumber]
  );
}
