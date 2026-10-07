// Export only valid frontend modules. The Python agents live under backend/agents and are not imported by the Vite bundle.
export const LayoutDetectionAgent = null;
export const ReadingOrderAgent = null;
export const TableExtractionAgent = null;
export const ChartFigureAgent = null;
export const EquationAgent = null;
export const JsonAssemblyAgent = null;
export const ConfidenceValidationAgent = null;
export const VirtualMergeAgent = null;
export const AuditAgent = null;
export const ExportAgent = null;
export const ConsensusAgent = null;
export const UrlGuardWebRenderAgent = null;
export const AccessControlAgent = null;
export const ChatSqlAgent = null;

// Direct list of all 24 agent definitions for health & contract checks
export const ALL_AGENTS = [
  { id: "01_file_validation", name: "01. File Validation", endpoint: "/agents/file-validation", method: "POST" },
  { id: "02_format_router", name: "02. Format Router", endpoint: "/agents/format-router", method: "POST" },
  { id: "03_native_text", name: "03. Native Text Extractor", endpoint: "/agents/native-text", method: "POST" },
  { id: "04_ocr", name: "04. OCR Engine", endpoint: "/agents/ocr", method: "POST" },
  { id: "05_layout", name: "05. Layout Detection", endpoint: "/agents/layout", method: "POST" },
  { id: "06_reading_order", name: "06. Reading Order", endpoint: "/agents/reading-order", method: "POST" },
  { id: "07_table", name: "07. Table Extraction", endpoint: "/agents/table", method: "POST" },
  { id: "08_spreadsheet", name: "08. Spreadsheet Extractor", endpoint: "/agents/spreadsheet", method: "POST" },
  { id: "09_chart_figure", name: "09. Chart & Figure Agent", endpoint: "/agents/chart-figure", method: "POST" },
  { id: "10_equation", name: "10. Equation Extractor", endpoint: "/agents/equation", method: "POST" },
  { id: "11_json_assembly", name: "11. JSON Assembly", endpoint: "/agents/json-assembly", method: "POST" },
  { id: "12_confidence_validation", name: "12. Confidence & Validation", endpoint: "/agents/confidence-validation", method: "POST" },
  { id: "13_virtual_merge", name: "13. Virtual Document Merge", endpoint: "/agents/virtual-merge", method: "POST" },
  { id: "14_case_linker", name: "14. Case Linker", endpoint: "/agents/case-linker", method: "POST" },
  { id: "15_fact_normalizer", name: "15. Fact Normalizer", endpoint: "/agents/fact-normalizer", method: "POST" },
  { id: "16_cross_doc_reasoning", name: "16. Cross-Doc Reasoning", endpoint: "/agents/cross-doc-reasoning", method: "POST" },
  { id: "17_action_draft", name: "17. Action Draft Agent", endpoint: "/agents/action-draft", method: "POST" },
  { id: "18_human_approval", name: "18. Human Approval Gateway", endpoint: "/agents/human-approval", method: "POST" },
  { id: "19_audit", name: "19. Immutable Audit Log", endpoint: "/agents/audit", method: "GET" },
  { id: "20_export", name: "20. Multi-Format Export Agent", endpoint: "/agents/export", method: "POST" },
  { id: "21_consensus", name: "21. Extractor Consensus & Coverage", endpoint: "/agents/consensus", method: "POST" },
  { id: "22_url_guard", name: "22. URL Guard & Web Ingestion", endpoint: "/agents/url-ingest", method: "POST" },
  { id: "23_access_control", name: "23. Governed Access Control", endpoint: "/agents/access/schema", method: "GET" },
  { id: "24_chat_sql", name: "24. Governed NL Chat SQL", endpoint: "/agents/chat-sql", method: "POST" },
] as const;
