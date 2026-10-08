import { useEffect, useState } from "react";
import { isImageLoaded, preloadImage } from "../../lib/evidence";

export type ImageReadiness = "idle" | "loading" | "ready" | "error";

/**
 * Loads an image once, lazily (only when `enabled` becomes true). An image that is already loaded is ready on the
 * first render and never requested again.
 */
export function useImageReady(src: string | undefined, enabled: boolean): ImageReadiness {
  const [state, setState] = useState<ImageReadiness>(() => (src && isImageLoaded(src) ? "ready" : "idle"));

  useEffect(() => {
    if (!src || !enabled) return;
    if (isImageLoaded(src)) {
      setState("ready");
      return;
    }
    let cancelled = false;
    setState("loading");
    preloadImage(src).then(
      () => {
        if (!cancelled) setState("ready");
      },
      () => {
        if (!cancelled) setState("error");
      }
    );
    return () => {
      cancelled = true;
    };
  }, [src, enabled]);

  return src && isImageLoaded(src) ? "ready" : state;
}
