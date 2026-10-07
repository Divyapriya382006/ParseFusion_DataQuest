"""
10_equation.py - Agent 10: Equation Recognition  (Person B).   POST /agents/equation

Equation regions of a page -> LaTeX (+ plain text, equation number) with parse + re-render verification.

Engines (extraction_method):
  "pdf_text_latex"  born-digital, single baseline: the text layer is converted deterministically (unicode -> LaTeX commands,
                    super/subscripts from span size + baseline offset, sqrt, fractions only if written with '/').  Exact, no model.
  "equation_model"  optional plug-in (pix2tex / Nougat / MathPix) via set_equation_engine(fn), used for scanned equations,
                    stacked layouts (fractions, matrices) and glyphs the converter cannot map.
  "none"            nothing could be recognised: latex = null (NOT guessed); OCR text, if any, is returned as plain_text only.

Pipeline (debug line per step):
  1 load page + layout, pick equation regions   2 crop (PDF: re-render clip at 300 dpi)   3 text-layer conversion attempt
  4 model attempt when 3 is not usable          5 equation number "(n)" split off   6 verify   7 confidence   8 store + audit

VERIFICATION (documented):
  parse_ok       own validator: balanced braces/brackets, matching \\begin/\\end, no empty command arguments, no unknown "\\\\command"
  render_ok      matplotlib mathtext can typeset it (if mathtext does not support a construct -> render_ok=false, reason given, NOT a failure of parse)
  symbol_match   (text-layer path) share of ASCII letters/digits of the source text that survive in the LaTeX
  aspect_ratio   (model path) min/max of width/height of ink in the original crop vs the re-rendered LaTeX
  passed         parse_ok and render_ok and (symbol_match >= 0.95  [text-layer]  |  aspect_ratio >= 0.5  [model])
CONFIDENCE (documented):  conf = base * factor
  base    = 0.90 (pdf_text_latex) | min(engine confidence, 0.85) (equation_model) | 0 (none)
  factor  = 1.0 if passed, 0.8 if parse_ok but not render_ok (construct unsupported by mathtext), 0.4 if parse_ok and render ok but similarity failed, 0.0 if not parse_ok
A latex string that fails parse_ok is NOT returned as `latex` (kept in `latex_raw` for the reviewer) and gets EQUATION_UNPARSEABLE.
"""
from __future__ import annotations

import io
import re
from collections import Counter
from typing import Callable, Optional

import numpy as np
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

try:
    from backend.agents import b_common as bc
except ImportError:  # pragma: no cover
    import b_common as bc  # type: ignore

fitz = bc.fitz
AGENT = "10_equation"
router = APIRouter()

_ENGINE: Optional[Callable] = None


def set_equation_engine(fn: Optional[Callable]) -> None:
    """fn(PIL RGB crop) -> {"latex": str, "confidence": float 0..1}  (pix2tex / Nougat / MathPix; LLMs only via common.llm_guard)"""
    global _ENGINE
    _ENGINE = fn


class EquationInput(BaseModel):
    source_id: str = Field(min_length=1, max_length=200)
    page_number: int = Field(ge=1, default=1)
    region_id: Optional[str] = None


class Verification(BaseModel):
    parse_ok: bool
    render_ok: bool
    render_error: Optional[str] = None
    symbol_match: Optional[float] = None
    aspect_ratio: Optional[float] = None
    passed: bool


class EquationResult(BaseModel):
    region_id: str
    latex: Optional[str] = None
    latex_raw: Optional[str] = None
    plain_text: Optional[str] = None
    equation_number: Optional[str] = None
    display: bool = True
    verification: Optional[Verification] = None
    location: bc.Location
    extraction_method: str
    confidence: float = Field(ge=0, le=1)
    signals: dict = {}
    warnings: list[bc.WarningItem] = []


class EquationOutput(BaseModel):
    source_id: str
    page_id: str
    page_number: int
    equations: list[EquationResult]
    warnings: list[bc.WarningItem] = []


# --------------------------------------------------------------------------- unicode -> LaTeX
GLYPH = {
    "α": r"\alpha", "β": r"\beta", "γ": r"\gamma", "δ": r"\delta", "ε": r"\epsilon", "ζ": r"\zeta", "η": r"\eta", "θ": r"\theta", "ι": r"\iota", "κ": r"\kappa",
    "λ": r"\lambda", "μ": r"\mu", "ν": r"\nu", "ξ": r"\xi", "π": r"\pi", "ρ": r"\rho", "σ": r"\sigma", "τ": r"\tau", "υ": r"\upsilon", "φ": r"\phi", "χ": r"\chi",
    "ψ": r"\psi", "ω": r"\omega", "Γ": r"\Gamma", "Δ": r"\Delta", "Θ": r"\Theta", "Λ": r"\Lambda", "Ξ": r"\Xi", "Π": r"\Pi", "Σ": r"\Sigma", "Φ": r"\Phi",
    "Ψ": r"\Psi", "Ω": r"\Omega", "≤": r"\leq", "≥": r"\geq", "≠": r"\neq", "≈": r"\approx", "±": r"\pm", "∞": r"\infty", "∂": r"\partial", "∇": r"\nabla",
    "×": r"\times", "÷": r"\div", "∈": r"\in", "∉": r"\notin", "⊂": r"\subset", "⊃": r"\supset", "⊆": r"\subseteq", "⊇": r"\supseteq", "∪": r"\cup", "∩": r"\cap",
    "→": r"\rightarrow", "←": r"\leftarrow", "⇒": r"\Rightarrow", "⇔": r"\Leftrightarrow", "∀": r"\forall", "∃": r"\exists", "∑": r"\sum", "∏": r"\prod", "∫": r"\int",
    "·": r"\cdot", "−": "-", "–": "-", "′": "'", "∝": r"\propto", "≡": r"\equiv", "∼": r"\sim", "°": r"^{\circ}", "…": r"\ldots",
}
KNOWN_CMDS = {c[1:] for c in GLYPH.values() if c.startswith("\\")} | {
    "frac", "sqrt", "sin", "cos", "tan", "log", "ln", "exp", "lim", "min", "max", "sum", "int", "prod", "left", "right", "begin", "end", "text", "mathrm", "mathbf",
    "mathcal", "mathbb", "hat", "bar", "vec", "dot", "overline", "underline", "cdot", "ldots", "quad", "qquad", "circ", "to", "infty", "binom", "over", "tilde", "lbrace", "rbrace",
    "langle", "rangle", "det", "arg", "sup", "inf", "gcd", "Pr", "mod", "bmod", "operatorname", "mathit", "limits", "nolimits", "lVert", "rVert", "vert", "Vert",
}
NUMBER_TAIL = re.compile(r"\s*\(\s*(\d+(?:\.\d+)?[a-z]?)\s*\)\s*$")


def _spans_in_region(ctx: bc.PageCtx, bbox_px: list) -> list:
    r = ctx.px_to_pt(bbox_px).normalize()
    with ctx.lock:
        d = ctx.page.get_text("dict", clip=r, flags=fitz.TEXT_MEDIABOX_CLIP)
    spans = []
    for b in d.get("blocks", []):
        for ln in b.get("lines", []):
            for sp in ln.get("spans", []):
                if sp["text"].strip():
                    spans.append({"text": sp["text"], "size": sp["size"], "x": sp["bbox"][0], "origin_y": sp["origin"][1], "line_y": round(ln["bbox"][3], 1)})
    return spans


def text_layer_to_latex(spans: list) -> tuple:
    """-> (latex|None, plain_text, info). None when stacked (several baselines), or an unmappable glyph is present."""
    if not spans:
        return None, "", {"reason": "no_text_layer"}
    main = max(spans, key=lambda s: (s["size"] * len(s["text"].strip())))
    ms = main["size"]
    base = main["origin_y"]
    # baselines of the "main sized" spans must agree, otherwise the equation is stacked (fraction / matrix / multi-line)
    mains = [s for s in spans if s["size"] >= 0.85 * ms]
    if max(s["origin_y"] for s in mains) - min(s["origin_y"] for s in mains) > 0.35 * ms:
        plain = " ".join(s["text"].strip() for s in sorted(spans, key=lambda s: (round(s["origin_y"]), s["x"])))
        return None, plain, {"reason": "stacked_layout"}
    seq = sorted(spans, key=lambda s: s["x"])
    out: list = []
    mode = None  # None | "^" | "_"
    plain_parts = []
    unknown: set = set()

    def close():
        nonlocal mode
        if mode:
            out.append("}")
            mode = None
    for s in seq:
        raw = s["text"]
        txt = raw.strip()
        plain_parts.append(txt)
        small = s["size"] < 0.8 * ms
        m = None
        if small and s["origin_y"] < base - 0.15 * ms:
            m = "^"
        elif small and s["origin_y"] > base + 0.1 * ms:
            m = "_"
        if m != mode:
            close()
            if m:
                out.append(f"{m}{{")
                mode = m
        conv = []
        for ch in txt:
            if ch in GLYPH:
                conv.append(GLYPH[ch] + (" " if GLYPH[ch].startswith("\\") else ""))
            elif ch == "√":
                conv.append("\\sqrt ")
            elif ord(ch) < 128 and (ch.isprintable()):
                conv.append(ch if ch not in "#$%&~" else "\\" + ch)
            else:
                unknown.add(ch)
        out.append((" " if raw[:1].isspace() else "") + "".join(conv) + (" " if raw[-1:].isspace() else ""))
    close()
    if unknown:
        return None, " ".join(plain_parts), {"reason": "unmapped_glyphs", "glyphs": sorted(unknown)}
    ltx = "".join(out)
    # \sqrt <token>  ->  \sqrt{<token>}   (token = one command, one symbol or one alphanumeric run)
    ltx = re.sub(r"\\sqrt\s+(\\[A-Za-z]+|[A-Za-z0-9]+|\([^()]*\))", lambda m: "\\sqrt{" + m.group(1).strip("()") + "}" if m.group(1).startswith("(") else "\\sqrt{" + m.group(1) + "}", ltx)
    ltx = re.sub(r"\s+", " ", ltx).strip()
    ltx = re.sub(r"\s*([\^_])\s*\{", r"\1{", ltx)
    ltx = re.sub(r"\{\s+", "{", ltx)
    ltx = re.sub(r"\s+\}", "}", ltx)
    ltx = re.sub(r"\}\s+(?=[\^_]\{)", "}", ltx)
    return ltx, " ".join(plain_parts), {"reason": "ok", "main_size": round(ms, 2)}


# --------------------------------------------------------------------------- verification
def validate_latex(s: str) -> tuple:
    """-> (ok, reason)"""
    if not s or not s.strip():
        return False, "empty"
    stack = []
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "\\":
            m = re.match(r"\\([A-Za-z]+|.)", s[i:])
            name = m.group(1)
            i += len(m.group(0))
            if name.isalpha() and name not in KNOWN_CMDS:
                return False, f"unknown_command:{name}"
            if name == "begin" or name == "end":
                mm = re.match(r"\{([A-Za-z*]+)\}", s[i:])
                if not mm:
                    return False, "bad_environment"
                if name == "begin":
                    stack.append(("env", mm.group(1)))
                else:
                    if not stack or stack[-1] != ("env", mm.group(1)):
                        return False, "environment_mismatch"
                    stack.pop()
                i += len(mm.group(0))
            continue
        if ch == "{":
            stack.append(("{", "{"))
        elif ch == "}":
            if not stack or stack[-1][0] != "{":
                return False, "unbalanced_braces"
            stack.pop()
        i += 1
    if stack:
        return False, "unclosed:" + stack[-1][1]
    if re.search(r"\\(frac|sqrt)\s*\{\s*\}", s) or "{}^" in s:
        return False, "empty_argument"
    if re.search(r"[\^_]\s*$", s):
        return False, "dangling_script"
    return True, "ok"


def render_latex(latex: str, dpi: int = 200) -> tuple:
    """-> (PIL gray image | None, error | None) via matplotlib mathtext (no TeX install needed)"""
    try:
        import matplotlib
        matplotlib.use("Agg", force=False)
        from matplotlib import mathtext
        from PIL import Image
        buf = io.BytesIO()
        mathtext.math_to_image(f"${latex}$", buf, dpi=dpi, format="png")
        buf.seek(0)
        return Image.open(buf).convert("L"), None
    except Exception as e:
        return None, f"{type(e).__name__}: {str(e).splitlines()[0][:120]}"


def _ink_aspect(gray: "np.ndarray") -> Optional[float]:
    import cv2
    g = np.asarray(gray)
    if g.size == 0:
        return None
    _, m = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    ys, xs = np.where(m > 0)
    if len(xs) < 5:
        return None
    return float((xs.max() - xs.min() + 1) / (ys.max() - ys.min() + 1))


def verify(latex: str, source_text: Optional[str], crop) -> Verification:
    parse_ok, why = validate_latex(latex)
    if not parse_ok:
        return Verification(parse_ok=False, render_ok=False, render_error=why, passed=False)
    img, err = render_latex(latex)
    render_ok = img is not None
    sym = ar = None
    if source_text is not None:
        src = Counter(c for c in source_text if c.isascii() and c.isalnum())
        got = Counter(c for c in re.sub(r"\\[A-Za-z]+", "", latex) if c.isascii() and c.isalnum())
        sym = round(sum(min(n, got[c]) for c, n in src.items()) / max(1, sum(src.values())), 3)
        ok_sim = sym >= 0.95
    else:
        ok_sim = False
        if render_ok and crop is not None:
            a1, a2 = _ink_aspect(np.asarray(crop.convert("L"))), _ink_aspect(np.asarray(img))
            if a1 and a2:
                ar = round(min(a1, a2) / max(a1, a2), 3)
                ok_sim = ar >= 0.5
    return Verification(parse_ok=True, render_ok=render_ok, render_error=err, symbol_match=sym, aspect_ratio=ar, passed=bool(render_ok and ok_sim))


def _crop_for(ctx: bc.PageCtx, bbox: list):
    """PIL crop; PDF: the clip re-rendered at 300 dpi (sharper than the page image)"""
    from PIL import Image
    b = bc.clamp_box([bbox[0] - 3, bbox[1] - 3, bbox[2] + 3, bbox[3] + 3], ctx.width, ctx.height)
    if ctx.kind == "pdf":
        try:
            with ctx.lock:
                r = ctx.px_to_pt(b).normalize()
                pm = ctx.page.get_pixmap(dpi=300, clip=r, alpha=False)
            return Image.frombytes("RGB", (pm.width, pm.height), pm.samples)
        except Exception as e:
            bc.dbg(AGENT, "rerender_failed_use_page_image", err=type(e).__name__)
    return ctx.img.crop(tuple(int(v) for v in b))


def analyze_region(ctx: bc.PageCtx, region: dict) -> EquationResult:
    t = bc.Timer()
    bbox = region["location"]["bbox"]
    warns: list = []
    crop = _crop_for(ctx, bbox)
    latex_raw = plain = None
    method, base, sig = "none", 0.0, {}
    if ctx.kind == "pdf":
        spans = _spans_in_region(ctx, bbox)
        ltx, plain, info = text_layer_to_latex(spans)
        sig["text_layer"] = info
        bc.dbg(AGENT, "text_layer", region_id=region["region_id"], spans=len(spans), reason=info.get("reason"), latex=ltx)
        if ltx:
            latex_raw, method, base = ltx, "pdf_text_latex", 0.9
        elif info.get("reason") == "unmapped_glyphs":
            warns.append(bc.warn("UNMAPPED_GLYPH", "The text layer contains symbols the converter cannot map", glyphs=info["glyphs"]))
        elif info.get("reason") == "stacked_layout":
            warns.append(bc.warn("STACKED_LAYOUT", "Stacked equation (fraction/matrix/multi-line); the text layer alone cannot give its structure"))
    if latex_raw is None and _ENGINE is not None:
        try:
            raw = _ENGINE(crop)
            lt = (raw or {}).get("latex")
            if isinstance(lt, str) and lt.strip():
                latex_raw, method, base = lt.strip(), "equation_model", min(float(raw.get("confidence", 0.5)), 0.85)
            else:
                warns.append(bc.warn("MODEL_EMPTY", "The equation model returned nothing"))
        except Exception as e:
            bc.dbg(AGENT, "engine_failed", err=type(e).__name__)
            warns.append(bc.warn("MODEL_FAILED", "The equation model failed", error=type(e).__name__))
    if latex_raw is None and plain is None:
        try:
            ws = bc.ocr_words(crop, psm=7)
            plain = " ".join(w["text"] for w in ws) or None
            sig["plain_text_source"] = "ocr"
        except bc.AgentError:
            plain = None
    if latex_raw is None and _ENGINE is None:
        warns.append(bc.warn("NO_EQUATION_ENGINE", "No equation model is configured and the text layer was not usable, so no LaTeX was produced"))
    # equation number
    number = None
    if latex_raw:
        m = NUMBER_TAIL.search(latex_raw)
        if m:
            number, latex_raw = m.group(1), latex_raw[:m.start()].rstrip()
    if plain:
        m = NUMBER_TAIL.search(plain)
        if m:
            number = number or m.group(1)
            plain = plain[:m.start()].rstrip()
    # verification
    ver = None
    latex = None
    conf = 0.0
    if latex_raw:
        ver = verify(latex_raw, plain if method == "pdf_text_latex" else None, crop)
        bc.dbg(AGENT, "verify", method=method, parse_ok=ver.parse_ok, render_ok=ver.render_ok, passed=ver.passed, sym=ver.symbol_match, aspect=ver.aspect_ratio)
        if ver.parse_ok:
            latex = latex_raw
            factor = 1.0 if ver.passed else (0.8 if not ver.render_ok else 0.4)
            if not ver.passed:
                warns.append(bc.warn("EQUATION_UNVERIFIED", "The LaTeX parsed but could not be fully verified by re-rendering", render_error=ver.render_error, symbol_match=ver.symbol_match, aspect_ratio=ver.aspect_ratio))
        else:
            factor = 0.0
            warns.append(bc.warn("EQUATION_UNPARSEABLE", "The recognised LaTeX is not valid and was not returned as `latex`", reason=ver.render_error))
        conf = base * factor
    bc.dbg(AGENT, "region_done", region_id=region["region_id"], method=method, confidence=round(conf, 3), ms=t.ms())
    return EquationResult(region_id=region["region_id"], latex=latex, latex_raw=(latex_raw if latex is None else None), plain_text=plain, equation_number=number, display=True,
                          verification=ver, location=ctx.loc(bbox), extraction_method=method, confidence=round(max(0.0, min(1.0, conf)), 3), signals=sig, warnings=warns)


def run(req: EquationInput, user: Optional[dict] = None) -> EquationOutput:
    if user is None:
        user = bc.current_user()
    t = bc.Timer()
    bc.dbg(AGENT, "start", source_id=req.source_id, page=req.page_number, region_id=req.region_id, user=user.get("user_id"))
    ctx = bc.load_page(req.source_id, req.page_number, user)
    layout = bc.get_layout(ctx)
    if req.region_id:
        reg = bc.find_region(layout, req.region_id)
        if reg["type"] != "equation":
            raise bc.AgentError("INVALID_INPUT", "region_id is not an equation region", {"type": reg["type"]})
        regions = [reg]
    else:
        regions = [r for r in layout["regions"] if r["type"] == "equation"]
    eqs = [analyze_region(ctx, r) for r in sorted(regions, key=lambda r: (r["location"]["bbox"][1], r["location"]["bbox"][0]))]
    warns = [] if eqs else [bc.warn("NO_EQUATIONS", "No equation regions on this page")]
    out = EquationOutput(source_id=ctx.source_id, page_id=ctx.page_id, page_number=ctx.page_number, equations=eqs, warnings=warns)
    try:
        bc.store().put("equations", ctx.page_id, bc.jsonable_encoder(out))
    except Exception as e:
        bc.dbg(AGENT, "store_put_failed_nonfatal", err=type(e).__name__)
    bc.audit("equation.recognised", "page", ctx.page_id, {"equations": len(eqs), "with_latex": sum(1 for e in eqs if e.latex)}, user=user)
    bc.dbg(AGENT, "done", equations=len(eqs), ms=t.ms())
    return out


@router.post("/agents/equation")
def equation_endpoint(body: dict, request: Request):
    return bc.handle(request, lambda: run(EquationInput.model_validate(body)))
