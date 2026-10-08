import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Crosshair } from "lucide-react";
import { getSourcePage } from "../../api/sources";
import { useEvidenceHighlight } from "../../context/EvidenceHighlightContext";
import type { HighlightBox } from "../../lib/evidence";
import { PageHighlightView } from "./PageHighlightView";

interface PageGroup {
  key: string;
  source_id: string;
  page_number: number;
  label: string;
}

function groupKey(b: HighlightBox): string {
  return `${b.source_id}::${b.page_number}`;
}

const PagePreview: React.FC<{ group: PageGroup; boxes: HighlightBox[] }> = ({ group, boxes }) => {
  const { data: page, isError } = useQuery({
    queryKey: ["sourcePage", group.source_id, group.page_number],
    queryFn: ({ signal }) => getSourcePage(group.source_id, group.page_number, signal),
    staleTime: Infinity,
    retry: 0,
  });
  const noBox = boxes.length > 0 && boxes.every((b) => !b.bbox);
  const reason = boxes.find((b) => b.bbox_unavailable_reason)?.bbox_unavailable_reason;

  return (
    <div data-testid="highlighted-page" className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/60 p-2">
      <div className="flex items-center justify-between text-[11px] font-mono text-neutral-400">
        <span className="truncate text-neutral-200">{group.label}</span>
        <span>Page {group.page_number}</span>
      </div>
      {page ? (
        <PageHighlightView
          imageUrl={page.image_url}
          pageWidth={page.width}
          pageHeight={page.height}
          boxes={boxes}
        />
      ) : (
        <div className="p-4 text-center text-[11px] text-neutral-500">
          {isError ? "Page preview unavailable" : "Loading page…"}
        </div>
      )}
      {noBox && reason && <p className="text-[11px] text-amber-300">{reason}</p>}
    </div>
  );
};

/**
 * Case-review centre preview. Shows the pages of whatever fact or finding is hovered, with every evidence box
 * drawn at once and labelled by its document. The last hovered pages stay visible (without boxes) so the pane
 * does not jump when the pointer moves away.
 */
export const HighlightedPagesPreview: React.FC = () => {
  const { boxes } = useEvidenceHighlight();
  const [groups, setGroups] = useState<PageGroup[]>([]);

  useEffect(() => {
    if (boxes.length === 0) return;
    const seen = new Map<string, PageGroup>();
    for (const b of boxes) {
      const key = groupKey(b);
      if (!seen.has(key)) {
        seen.set(key, { key, source_id: b.source_id, page_number: b.page_number, label: b.label ?? b.source_id });
      }
    }
    setGroups(Array.from(seen.values()));
  }, [boxes]);

  const boxesByGroup = useMemo(() => {
    const map = new Map<string, HighlightBox[]>();
    for (const b of boxes) {
      const key = groupKey(b);
      map.set(key, [...(map.get(key) ?? []), b]);
    }
    return map;
  }, [boxes]);

  if (groups.length === 0) {
    return (
      <div
        data-testid="highlighted-pages-empty"
        className="flex items-center gap-2 rounded-xl border border-dashed border-neutral-800 p-4 text-[11px] text-neutral-500"
      >
        <Crosshair className="h-3.5 w-3.5 shrink-0" />
        <span>Hover or focus a fact or finding to see where its evidence sits on the source pages.</span>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="highlighted-pages">
      {groups.map((g) => (
        <PagePreview key={g.key} group={g} boxes={boxesByGroup.get(g.key) ?? []} />
      ))}
    </div>
  );
};
