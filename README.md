# ParseFusion Frontend

ParseFusion is a document-and-case intelligence web application built with React 18, TypeScript (strict), Vite, Tailwind CSS, TanStack Query, and Lucide React.

It connects to 24 specialized backend agents that execute parallel extraction juries, evidence anchoring, fact normalization, cross-document reasoning, and governed column-level access control.

---

## Backend Connection & Configuration

### 1. Setting `VITE_API_BASE_URL`
Copy `.env.example` to `.env` or set the environment variable directly:

```bash
VITE_API_BASE_URL="http://localhost:8000"
```

If `VITE_API_BASE_URL` is unset or the backend server is unreachable, ParseFusion safely displays a typed `Backend not connected: <endpoint>` state. It **never** substitutes fake or invented fallback data.

### 2. Verifying Wiring via Agent Status Page
Navigate to the **Agent Status** tab (`/agent-status`) in the left navigation sidebar.
- Inspect real-time agent telemetry from `GET /health/agents`.
- Click the **"Run Contract Check"** button to ping all 24 individual agent endpoints and verify request routing.

---

## 24 Agent Registry

The endpoint registry and TypeScript client modules are under `src/agents/`. Python backend implementations
for agents 01-04 and 08 are under `backend/agents/`.

| # | File | Endpoint | Method | Purpose |
|---|---|---|---|---|
| 01 | `backend/agents/01_file_validation.py` | `/agents/file-validation` | POST | Multi-format binary validation & hashing |
| 02 | `backend/agents/02_format_router.py` | `/agents/format-router` | POST | Route determination & page classification |
| 03 | `backend/agents/03_native_text.py` | `/agents/native-text` | POST | Native PDF/digital text extraction |
| 04 | `backend/agents/04_ocr.py` | `/agents/ocr` | POST | Optical character recognition |
| 05 | `05_layoutDetection.ts` | `/agents/layout` | POST | Layout zones & reading segments |
| 06 | `06_readingOrder.ts` | `/agents/reading-order` | POST | Topological reading order |
| 07 | `07_tableExtraction.ts` | `/agents/table` | POST | Table grid & cell spans |
| 08 | `backend/agents/08_spreadsheet.py` | `/agents/spreadsheet` | POST | Workbook formulas & hidden cells |
| 09 | `09_chartFigure.ts` | `/agents/chart-figure` | POST | Charts & graphic visual figures |
| 10 | `10_equation.ts` | `/agents/equation` | POST | LaTeX math expressions & verification |
| 11 | `11_jsonAssembly.ts` | `/agents/json-assembly` | POST | Assembles canonical SourceDocument |
| 12 | `12_confidenceValidation.ts` | `/agents/confidence-validation` | POST | Confidence scores & validation badges |
| 13 | `13_virtualMerge.ts` | `/agents/virtual-merge` | POST | Virtual multi-source document merge |
| 14 | `src/agents/14_caseLinker.py` | `/agents/case-linker` | POST | Case document association & verification |
| 15 | `src/agents/15_factNormalizer.py` | `/agents/fact-normalizer` | POST | Normalizes currency, units, dates, metrics |
| 16 | `src/agents/16_crossDocReasoning.py` | `/agents/cross-doc-reasoning` | POST | Cross-doc comparisons & neutral findings |
| 17 | `src/agents/17_actionDraft.py` | `/agents/action-draft` | POST | Automated follow-up action drafting |
| 18 | `src/agents/18_humanApproval.py` | `/agents/human-approval` | POST | Human review, edit, approve & execute |
| 19 | `19_audit.ts` | `/agents/audit` | GET | Cryptographic Merkle audit ledger |
| 20 | `20_export.ts` | `/agents/export` | POST | Multi-format exports with manifest & hash |
| 21 | `21_consensus.ts` | `/agents/consensus` | POST | Extractor jury consensus & coverage |
| 22 | `22_urlGuardWebRender.ts` | `/agents/url-ingest` | POST | Policy-governed web URL ingestion |
| 23 | `23_accessControl.ts` | `/agents/access/schema` | GET | Column-level masking & elevation requests |
| 24 | `24_chatSql.ts` | `/agents/chat-sql` | POST | Governed natural-language SQL assistant |

Detailed contract schemas are documented in `docs/CONTRACT.md`.

### Python backend setup and tests

Install backend dependencies with `pip install -r requirements-backend.txt`. Run the supplied
agent 01-04/08 and notification tests with `pip install -r requirements-dev.txt` followed by
`pytest tests/test_person_a.py -q`. Tesseract OCR tests are skipped when the Tesseract executable
or required language data is unavailable.
