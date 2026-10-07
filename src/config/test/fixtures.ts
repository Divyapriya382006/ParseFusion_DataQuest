import type { EvidenceReference, PageUnit } from "../types/canonical";

export function makePage(overrides: Partial<PageUnit> = {}): PageUnit {
  return {
    page_id: "page_1",
    source_id: "src_1",
    unit_id: "unit_1",
    page_number: 3,
    width: 1000,
    height: 1400,
    rotation: 0,
    layout_class: "form",
    reading_order_confidence: 1,
    image_url: "/images/page_1.png",
    blocks: [
      {
        block_id: "blk_1",
        type: "text",
        source_id: "src_1",
        page_id: "page_1",
        reading_order_index: 0,
        location: {
          bbox: [100, 200, 300, 260],
          coordinate_system: "pixel_top_left",
          page_width: 1000,
          page_height: 1400,
        },
        confidence: 0.91,
        extraction_method: "native_text",
        raw_text: "Total 5,000",
        needs_review: false,
        warnings: [],
      },
      {
        block_id: "blk_nobox",
        type: "text",
        source_id: "src_1",
        page_id: "page_1",
        reading_order_index: 1,
        location: {
          bbox: null,
          coordinate_system: "pixel_top_left",
          page_width: 1000,
          page_height: 1400,
          bbox_unavailable_reason: "Handwritten region could not be located",
        },
        confidence: 0.4,
        extraction_method: "vision_model",
        raw_text: "scribble",
        needs_review: true,
        warnings: [],
      },
    ],
    ...overrides,
  };
}

export function makeEvidence(overrides: Partial<EvidenceReference> = {}): EvidenceReference {
  return {
    source_id: "src_1",
    filename: "income_certificate.pdf",
    page_number: 3,
    block_id: "blk_1",
    text_excerpt: "Total 5,000",
    bbox: [100, 200, 300, 260],
    confidence: 0.91,
    ...overrides,
  };
}
