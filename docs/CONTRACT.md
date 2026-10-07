# ParseFusion Agent Backend Contract

This document specifies the exact request and response schemas for all 24 backend agents in ParseFusion.
All endpoints use the standard JSON envelope unless binary upload/download is specified:

**Success Envelope:**
```json
{
  "ok": true,
  "data": { ... },
  "request_id": "req_xyz"
}
```

**Failure Envelope:**
```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable neutral description",
    "details": {}
  },
  "request_id": "req_xyz"
}
```

---

## Agent Endpoints Contract

### 01. File Validation
- **Endpoint:** `POST /agents/file-validation`
- **Content-Type:** `multipart/form-data`
- **Request:**
  - `file`: Binary file upload (PDF, DOCX, XLSX, images, CSV, EML, HTML)
  - `options` (optional): `{"password": "..."}`
- **Response Data:**
  ```json
  {
    "source_id": "src_123",
    "sanitized_filename": "invoice_2026.pdf",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "detected_mime": "application/pdf",
    "size_bytes": 1048576,
    "page_count": 4,
    "status": "accepted",
    "duplicate_of": null
  }
  ```

### 02. Format Router
- **Endpoint:** `POST /agents/format-router`
- **Request:** `{"source_id": "src_123"}`
- **Response Data:**
  ```json
  {
    "source_id": "src_123",
    "route": "standard_mixed_layout",
    "units": [
      { "unit_id": "unit_1", "page_number": 1, "page_class": "letterhead_form" }
    ]
  }
  ```

### 03. Native Text Extractor
- **Endpoint:** `POST /agents/native-text`
- **Request:** `{"source_id": "src_123", "page_number": 1}`
- **Response Data:**
  ```json
  {
    "page_id": "page_1",
    "spans": [
      {
        "text": "Total Balance",
        "location": { "bbox": [100, 200, 300, 240], "coordinate_system": "pixel_top_left", "page_width": 1200, "page_height": 1600 },
        "font": "Helvetica-Bold",
        "confidence": 0.99
      }
    ],
    "has_usable_text": true
  }
  ```

### 04. OCR Engine
- **Endpoint:** `POST /agents/ocr`
- **Request:** `{"source_id": "src_123", "page_number": 1, "region": null, "engine": "tesseract"}`
- **Response Data:**
  ```json
  {
    "engine": "tesseract_v5",
    "lines": [
      {
        "text": "Vendor Name",
        "location": { "bbox": [50, 80, 250, 110], "coordinate_system": "pixel_top_left", "page_width": 1200, "page_height": 1600 },
        "confidence": 0.96
      }
    ],
    "handwriting_detected": false
  }
  ```

### 05. Layout Detection
- **Endpoint:** `POST /agents/layout`
- **Request:** `{"source_id": "src_123", "page_number": 1}`
- **Response Data:**
  ```json
  {
    "layout_class": "structured_invoice",
    "regions": [
      {
        "region_id": "reg_1",
        "type": "table",
        "location": { "bbox": [100, 300, 1100, 800], "coordinate_system": "pixel_top_left", "page_width": 1200, "page_height": 1600 },
        "confidence": 0.98
      }
    ]
  }
  ```

### 06. Reading Order
- **Endpoint:** `POST /agents/reading-order`
- **Request:** `{"page_id": "page_1", "region_ids": ["reg_1", "reg_2"]}`
- **Response Data:**
  ```json
  {
    "ordered_ids": ["reg_2", "reg_1"],
    "reading_order_confidence": 0.94,
    "warnings": []
  }
  ```

### 07. Table Extraction
- **Endpoint:** `POST /agents/table`
- **Request:** `{"source_id": "src_123", "page_number": 1, "region_id": "reg_1"}`
- **Response Data:**
  ```json
  {
    "block_id": "blk_tbl_1",
    "table_id": "tbl_1",
    "type": "table",
    "source_id": "src_123",
    "page_id": "page_1",
    "reading_order_index": 2,
    "location": { "bbox": [100, 300, 1100, 800], "coordinate_system": "pixel_top_left", "page_width": 1200, "page_height": 1600 },
    "confidence": 0.95,
    "extraction_method": "cascade_table_net",
    "needs_review": false,
    "warnings": [],
    "n_rows": 3,
    "n_cols": 3,
    "cells": [
      {
        "row": 0, "col": 0, "row_span": 1, "col_span": 1, "is_header": true,
        "raw_text": "Item",
        "location": { "bbox": [100, 300, 400, 340], "coordinate_system": "pixel_top_left", "page_width": 1200, "page_height": 1600 },
        "confidence": 0.99
      }
    ],
    "badges": [{ "label": "Column sum verified", "status": "success" }]
  }
  ```

### 08. Spreadsheet Extractor
- **Endpoint:** `POST /agents/spreadsheet`
- **Request:** `{"source_id": "src_123"}`
- **Response Data:**
  ```json
  {
    "sheets": [
      {
        "name": "Summary",
        "hidden": false,
        "used_range": "A1:G40",
        "merged_ranges": ["A1:C1"],
        "probable_tables": ["A3:G35"],
        "cells": [
          { "ref": "A1", "raw_value": 4500.5, "displayed_value": "$4,500.50", "formula": "=SUM(A2:A10)", "number_format": "$#,##0.00" }
        ]
      }
    ]
  }
  ```

### 09. Chart & Figure Agent
- **Endpoint:** `POST /agents/chart-figure`
- **Request:** `{"source_id": "src_123", "page_number": 1, "region_id": "reg_chart"}`
- **Response Data:**
  ```json
  {
    "block_id": "blk_chart_1",
    "type": "chart",
    "chart_id": "ch_1",
    "source_id": "src_123",
    "page_id": "page_1",
    "reading_order_index": 3,
    "location": { "bbox": [50, 500, 600, 900], "coordinate_system": "pixel_top_left", "page_width": 1200, "page_height": 1600 },
    "confidence": 0.91,
    "crop_url": "/api/crops/ch_1.png",
    "series": [{ "name": "Q1 Revenue", "points": [{ "x": "Jan", "y": 1200 }] }]
  }
  ```

### 10. Equation Extractor
- **Endpoint:** `POST /agents/equation`
- **Request:** `{"source_id": "src_123", "page_number": 1, "region_id": "reg_eq"}`
- **Response Data:**
  ```json
  {
    "block_id": "blk_eq_1",
    "type": "equation",
    "equation_id": "eq_1",
    "source_id": "src_123",
    "page_id": "page_1",
    "reading_order_index": 4,
    "location": { "bbox": [100, 950, 500, 1020], "coordinate_system": "pixel_top_left", "page_width": 1200, "page_height": 1600 },
    "confidence": 0.97,
    "latex": "E = mc^2",
    "crop_url": "/api/crops/eq_1.png",
    "verified": true
  }
  ```

### 11. JSON Assembly
- **Endpoint:** `POST /agents/json-assembly`
- **Request:** `{"source_id": "src_123"}`
- **Response Data:** Canonical `SourceDocument` including all pages and structured blocks.

### 12. Confidence & Validation
- **Endpoint:** `POST /agents/confidence-validation`
- **Request:** `{"source_id": "src_123"}`
- **Response Data:**
  ```json
  {
    "document_confidence": 0.94,
    "blocks": [
      {
        "block_id": "blk_tbl_1",
        "confidence": 0.95,
        "confidence_breakdown": { "ocr": 0.98, "geometry": 0.92 },
        "checks": [{ "name": "arithmetic_integrity", "status": "verified" }],
        "needs_review": false
      }
    ],
    "badges": [{ "scope_id": "src_123", "label": "Full validation passed", "status": "nominal" }]
  }
  ```

### 13. Virtual Document Merge
- **Endpoint:** `POST /agents/virtual-merge`
- **Request:** `{"batch_id": "b_1", "ordered_source_ids": ["src_1", "src_2"]}`
- **Response Data:**
  ```json
  {
    "virtual_document_id": "vdoc_1",
    "pages": [
      { "virtual_page_number": 1, "source_id": "src_1", "page_number": 1, "page_id": "p_1", "boundary_start": true }
    ]
  }
  ```

### 14. Case Linker
- **Endpoint:** `POST /agents/case-linker`
- **Request:** `{"case_id": "case_1", "source_ids": ["src_1"], "mode": "suggest"}`
- **Response Data:**
  ```json
  {
    "links": [
      {
        "link_id": "lnk_1",
        "case_id": "case_1",
        "source_id": "src_1",
        "relationship_type": "supporting_voucher",
        "relationship_confidence": 0.88,
        "matching_signals": ["tax_id_match", "date_window_align"],
        "linked_by": "agent_14",
        "linked_at": "2026-10-07T00:00:00Z",
        "human_verified": false
      }
    ]
  }
  ```
- **Decision Endpoint:** `POST /agents/case-linker/decision`
- **Request:** `{"link_id": "lnk_1", "decision": "confirm"}`
- **Response Data:** `{"link_id": "lnk_1", "human_verified": true}`

### 15. Fact Normalizer
- **Endpoint:** `POST /agents/fact-normalizer`
- **Request:** `{"case_id": "case_1"}`
- **Response Data:**
  ```json
  {
    "facts": [
      {
        "fact_id": "fact_1",
        "subject": "Acme Corp",
        "metric": "Gross Revenue",
        "raw_text": "USD 1,200,000",
        "raw_value": "1200000",
        "normalized_value": 1200000,
        "currency": "USD",
        "normalization_rule": "iso_4217_parser",
        "confidence": 0.99,
        "evidence": [
          { "source_id": "src_1", "filename": "10k.pdf", "page_number": 12, "block_id": "blk_4", "text_excerpt": "Gross Revenue: USD 1,200,000", "bbox": [100, 200, 400, 250], "confidence": 0.99 }
        ]
      }
    ]
  }
  ```

### 16. Cross-Document Reasoning
- **Endpoint:** `POST /agents/cross-doc-reasoning`
- **Request:** `{"case_id": "case_1"}`
- **Response Data:**
  ```json
  {
    "comparisons": [
      { "comparison_id": "cmp_1", "fact_ids": ["fact_1", "fact_2"], "comparable": true, "checks": [] }
    ],
    "not_comparable": [],
    "findings": [
      {
        "finding_id": "fnd_1",
        "case_id": "case_1",
        "category": "discrepancy_analysis",
        "severity": "medium",
        "status": "pending_review",
        "title": "Reported Revenue Variance",
        "statement": "Values reported in annual summary differ from quarterly statements by 4.2%.",
        "difference_absolute": 50000,
        "difference_percentage": 4.2,
        "confidence": 0.92,
        "human_review_required": true,
        "possible_explanations": ["Accrual timing adjustment", "Currency exchange rate differential"],
        "recommended_review_action": "Request reconciliation ledger",
        "evidence_references": []
      }
    ]
  }
  ```

### 17. Action Draft Agent
- **Endpoint:** `POST /agents/action-draft`
- **Request:** `{"case_id": "case_1", "finding_id": "fnd_1", "action_type": "request_clarification"}`
- **Response Data:** Complete `ProposedAction` object.

### 18. Human Approval Gateway
- **Endpoint:** `POST /agents/human-approval`
- **Request:** `{"action_id": "act_1", "decision": "approve", "notes": "Verified against bank records"}`
- **Response Data:**
  ```json
  {
    "action": { ... },
    "event": {
      "event_id": "ev_1",
      "actor_id": "usr_99",
      "actor_role": "compliance_officer",
      "event_type": "approval_granted",
      "event_timestamp": "2026-10-07T02:00:00Z",
      "previous_status": "draft",
      "new_status": "approved",
      "content_hash": "a1b2c3..."
    },
    "signature": {
      "signed_by": "usr_99",
      "algorithm": "ECDSA_P256",
      "value": "30450221..."
    }
  }
  ```

### 19. Immutable Audit Log
- **Endpoint:** `GET /agents/audit`
- **Query Params:** `from`, `to`, `actor`, `event_type`, `case_id`, `object_id`, `cursor`
- **Response Data:**
  ```json
  {
    "events": [
      {
        "event_id": "ev_1",
        "timestamp": "2026-10-07T01:00:00Z",
        "actor_id": "usr_42",
        "actor_role": "auditor",
        "event_type": "document_ingested",
        "object_type": "source_document",
        "object_id": "src_1",
        "details": {},
        "prev_hash": "000000...",
        "hash": "8f3b..."
      }
    ],
    "chain_valid": true,
    "next_cursor": null
  }
  ```

### 20. Multi-Format Export Agent
- **Endpoint:** `POST /agents/export`
- **Request:** `{"scope": {"type": "case", "ids": ["case_1"]}, "format": "zip_bundle", "options": {"masked": false, "include_evidence": true}}`
- **Response Data:**
  ```json
  {
    "export_id": "exp_1",
    "format": "zip_bundle",
    "download_url": "/api/exports/exp_1.zip",
    "content_hash": "c7a8...",
    "signed_manifest_url": "/api/exports/exp_1_manifest.json",
    "created_at": "2026-10-07T02:30:00Z"
  }
  ```
- **History Endpoint:** `GET /agents/export/history`

### 21. Extractor Consensus & Coverage
- **Endpoint:** `POST /agents/consensus`
- **Request:** `{"source_id": "src_1", "page_number": 1}`
- **Response Data:**
  ```json
  {
    "blocks": [
      {
        "block_id": "blk_1",
        "winner": "native_text",
        "agreement": "high",
        "candidates": [
          { "extractor": "native_text", "value": "Invoice #4401", "confidence": 0.99 },
          { "extractor": "ocr_tesseract", "value": "Invoice #4401", "confidence": 0.95 }
        ],
        "escalated": false,
        "needs_review": false
      }
    ],
    "coverage": [
      { "page_number": 1, "coverage_score": 0.98, "uncovered_regions": [] }
    ]
  }
  ```

### 22. URL Guard & Web Ingestion
- **Endpoint:** `POST /agents/url-ingest`
- **Request:** `{"url": "https://example.com/filing", "purpose": "SEC evidence retrieval"}`
- **Response Data:**
  ```json
  {
    "status": "allowed",
    "robots_checked": true,
    "source_id": "src_web_1",
    "snapshot": {
      "screenshot_url": "/api/snapshots/snap_1.png",
      "fetched_at": "2026-10-07T02:00:00Z"
    }
  }
  ```

### 23. Governed Access Control & Column-Level Security
- **Endpoints:**
  - `GET /agents/access/schema`: Returns table catalog with column masking/lock flags.
  - `GET /agents/access/preview?resource_id=tbl_1&limit=25`: Returns schema preview (locked columns arrive as null).
  - `POST /agents/access/request`: Elevation request (`{"resource_id": "tbl_1", "columns": ["ssn"], "reason": "Audit 2026"}`).
  - `GET /agents/access/requests`: List pending requests for administrator review.
  - `POST /agents/access/decision`: Approve or reject (`{"request_id": "req_1", "decision": "approve"}`).

### 24. Governed NL Chat SQL
- **Endpoint:** `POST /agents/chat-sql`
- **Request:** `{"question": "What is the discrepancy in total revenue for case 1?", "scope": {"case_id": "case_1"}}`
- **Response Data:**
  ```json
  {
    "conversation_id": "conv_1",
    "sql": "SELECT metric, difference_absolute FROM findings WHERE case_id = 'case_1'",
    "analysis": {
      "operation": "SELECT",
      "tables": ["findings"],
      "columns": ["metric", "difference_absolute"]
    },
    "decision": "ALLOW",
    "columns": [
      { "name": "metric", "locked": false },
      { "name": "difference_absolute", "locked": false }
    ],
    "rows": [["Gross Revenue", 50000]],
    "answer_text": "The potential variance observed in Gross Revenue is 50,000.",
    "citations": []
  }
  ```
