import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { clearThumbnailCache, resetImageCache } from "../lib/evidence";

afterEach(() => {
  cleanup();
  clearThumbnailCache();
  resetImageCache();
});
