import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { useEvidence } from "../../context/EvidenceContext";
import { useEvidenceHighlight } from "../../context/EvidenceHighlightContext";
import type { EvidenceReference, PageUnit } from "../../types/canonical";
import { isRestricted, toHighlightBoxes } from "../../lib/evidence";
import { EvidencePopover } from "./EvidencePopover";
import type { AnchorRect } from "./EvidencePopover";

export const HOVER_DELAY_MS = 300;
const CLOSE_GRACE_MS = 120;

export interface UseEvidenceHoverOptions {
  evidence: EvidenceReference | null | undefined;
  /** Page the caller already loaded (e.g. the Source Viewer). Avoids fetching it again. */
  pageData?: PageUnit;
  /** What "open the source" means here. Defaults to opening the full Source Viewer on the evidence. */
  onActivate?: () => void;
  /** Clicking the anchor activates it. Turn off when the anchor already handles its own click. */
  openOnClick?: boolean;
  /** Publish the evidence box for two-way highlighting while hovered or focused. */
  highlight?: boolean;
  delayMs?: number;
  disabled?: boolean;
}

export interface EvidenceAnchorProps {
  ref: (el: Element | null) => void;
  onPointerEnter: (e: React.PointerEvent<Element>) => void;
  onPointerLeave: (e: React.PointerEvent<Element>) => void;
  onPointerDown: (e: React.PointerEvent<Element>) => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent<Element>) => void;
  onClickCapture: (e: React.MouseEvent<Element>) => void;
  onClick: (e: React.MouseEvent<Element>) => void;
  "aria-describedby": string | undefined;
}

export interface UseEvidenceHoverResult {
  anchorProps: EvidenceAnchorProps;
  /** Render this next to the anchor. It portals itself to document.body. */
  popover: React.ReactNode;
  isOpen: boolean;
  popoverId: string;
}

/**
 * Hover / focus / touch behaviour of hover-to-source.
 *  - hover or keyboard focus opens the popover after a delay; leaving cancels a pending open
 *  - Esc closes it; Enter on the focused anchor (or a click on the popover) activates the source
 *  - touch: the first tap shows the popover, the second tap activates
 */
export function useEvidenceHover(options: UseEvidenceHoverOptions): UseEvidenceHoverResult {
  const { evidence, pageData, openOnClick = true, highlight = true, delayMs = HOVER_DELAY_MS, disabled = false } = options;
  const { openEvidence } = useEvidence();
  const { setOwnerBoxes, clearOwner } = useEvidenceHighlight();

  const popoverId = `evidence-popover-${useId().replace(/:/g, "")}`;
  const ownerId = popoverId;
  const anchorEl = useRef<Element | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointerType = useRef<string>("mouse");
  const [anchorRect, setAnchorRect] = useState<AnchorRect | null>(null);

  const restricted = isRestricted(evidence);
  const active = Boolean(evidence) && !disabled;
  const isOpen = active && anchorRect !== null;

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const measure = useCallback(() => {
    const el = anchorEl.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchorRect({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
  }, []);

  const open = useCallback(() => {
    if (!active) return;
    clearTimers();
    measure();
  }, [active, clearTimers, measure]);

  const close = useCallback(() => {
    clearTimers();
    setAnchorRect(null);
  }, [clearTimers]);

  const scheduleOpen = useCallback(() => {
    if (!active) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (isOpen || openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      measure();
    }, delayMs);
  }, [active, isOpen, delayMs, measure]);

  const scheduleClose = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current); // cancel a pending open
    openTimer.current = null;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setAnchorRect(null);
    }, CLOSE_GRACE_MS);
  }, []);

  const publishHighlight = useCallback(() => {
    if (!highlight || !evidence || restricted) return;
    setOwnerBoxes(ownerId, toHighlightBoxes([evidence]));
  }, [highlight, evidence, restricted, setOwnerBoxes, ownerId]);

  const activate = useCallback(() => {
    if (!evidence || restricted) return;
    close();
    if (options.onActivate) options.onActivate();
    else openEvidence(evidence);
  }, [evidence, restricted, close, options, openEvidence]);

  // Esc closes; a tap or click outside closes (touch); scroll/resize re-anchors.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      const popover = document.getElementById(popoverId);
      if (target && (anchorEl.current?.contains(target) || popover?.contains(target))) return;
      close();
    };
    const onMove = () => measure();
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [isOpen, close, measure, popoverId]);

  // Clean up timers and highlight on unmount.
  useEffect(
    () => () => {
      clearTimers();
      clearOwner(ownerId);
    },
    [clearTimers, clearOwner, ownerId]
  );

  const anchorProps: EvidenceAnchorProps = {
    ref: (el) => {
      anchorEl.current = el;
    },
    onPointerEnter: (e) => {
      if (e.pointerType === "touch") return;
      publishHighlight();
      scheduleOpen();
    },
    onPointerLeave: (e) => {
      if (e.pointerType === "touch") return;
      clearOwner(ownerId);
      scheduleClose();
    },
    onPointerDown: (e) => {
      lastPointerType.current = e.pointerType || "mouse";
    },
    onFocus: () => {
      publishHighlight();
      scheduleOpen();
    },
    onBlur: () => {
      clearOwner(ownerId);
      scheduleClose();
    },
    onKeyDown: (e) => {
      if (e.key === "Enter" && e.target === e.currentTarget) {
        e.preventDefault();
        activate();
      }
    },
    onClickCapture: (e) => {
      // Touch: first tap shows the popover and swallows the click; the second tap falls through to activate.
      if (!active || lastPointerType.current !== "touch") return;
      if (!isOpen) {
        e.preventDefault();
        e.stopPropagation();
        publishHighlight();
        open();
      }
    },
    onClick: (e) => {
      if (!openOnClick || e.defaultPrevented) return;
      activate();
    },
    "aria-describedby": isOpen ? popoverId : undefined,
  };

  const popover =
    isOpen && evidence && anchorRect ? (
      <EvidencePopover
        id={popoverId}
        evidence={evidence}
        anchorRect={anchorRect}
        pageData={pageData}
        onActivate={activate}
        onPointerEnter={() => {
          if (closeTimer.current) clearTimeout(closeTimer.current);
          closeTimer.current = null;
        }}
        onPointerLeave={scheduleClose}
      />
    ) : null;

  return { anchorProps, popover, isOpen, popoverId };
}
