import React, { useEffect, useRef, useState } from "react";
import { MessageSquareText, Send, AlertTriangle } from "lucide-react";
import { apiClient } from "../api/client";
import { listSources } from "../api/sources";
import { ChartPanel } from "../components/chat/ChartPanel";

interface Source { source_id: string; filename: string; page: number; type: string; text: string }
interface Answer {
  answer: string;
  mode: "groq" | "extractive" | "none";
  sources: Source[];
  error: { code: string; message: string } | null;
}
interface Status { configured: boolean; model: string; reachable: boolean | null; error: { code: string; message: string } | null }
interface DocOption { source_id: string; filename: string; page_count?: number }
interface Turn { role: "user" | "assistant"; content: string; data?: Answer }

export const ChatPage: React.FC = () => {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [docs, setDocs] = useState<DocOption[]>([]);
  const [docId, setDocId] = useState<string>("");   // "" = all documents
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listSources()
      .then((r) => {
        const ready = r.sources.filter((d) => d.status === "completed") as unknown as DocOption[];
        setDocs(ready);
        setDocId((cur) => cur || (ready.length === 1 ? ready[0].source_id : ""));
      })
      .catch(() => setDocs([]));
  }, []);

  useEffect(() => {
    apiClient<Status>("/agents/doc-chat/status").then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [turns]);

  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((t) => [...t, { role: "user", content: q }]);
    setText("");
    setBusy(true);
    try {
      const data = await apiClient<Answer>("/agents/doc-chat", { method: "POST", body: { question: q, history, source_ids: docId ? [docId] : undefined } });
      setTurns((t) => [...t, { role: "assistant", content: data.answer, data }]);
    } catch (e) {
      setTurns((t) => [...t, { role: "assistant", content: `Request failed: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-bold text-neutral-100 flex items-center gap-2">
          <MessageSquareText className="w-5 h-5 text-sky-400" />
          <span>Document Chat</span>
        </h1>
        <p className="text-xs text-neutral-400 mt-1">
          Ask about anything parsed so far: text, tables, OCR output and the values read from bar charts. Answers cite the document and page.
        </p>
        {status && (status.error || status.reachable === false) && (
          <p className="mt-2 text-xs text-amber-400 flex items-center gap-1" data-testid="chat-status">
            <AlertTriangle className="w-3.5 h-3.5" /> {status.error?.message ?? "Groq is not reachable."}
          </p>
        )}
        {status?.reachable && <p className="mt-2 text-xs text-emerald-400">Connected to Groq ({status.model})</p>}
      </div>

      <div className="flex items-center gap-2 text-sm">
        <label htmlFor="chat-doc" className="text-neutral-400">Document</label>
        <select
          id="chat-doc"
          value={docId}
          onChange={(e) => { setDocId(e.target.value); setTurns([]); }}
          className="flex-1 rounded-md bg-neutral-900 border border-neutral-700 px-2 py-1.5 text-neutral-100"
        >
          <option value="">All parsed documents ({docs.length})</option>
          {docs.map((d) => (
            <option key={d.source_id} value={d.source_id}>{d.filename || d.source_id.slice(0, 8)}</option>
          ))}
        </select>
      </div>
      {docs.length === 0 && <p className="text-xs text-neutral-500">No parsed documents yet. Upload and parse one first.</p>}

      <ChartPanel sourceIds={docId ? [docId] : docs.map((d) => d.source_id)} onAsk={setText} />

      <div className="space-y-3 min-h-[240px]">
        {turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "text-right" : ""}>
            <div className={`inline-block max-w-[90%] text-left rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${t.role === "user" ? "bg-sky-900/40 text-sky-100" : "bg-neutral-800 text-neutral-100"}`}>
              {t.content}
            </div>
            {t.data?.error && <div className="text-xs text-amber-400 mt-1">{t.data.error.code}: {t.data.error.message}</div>}
            {t.data && t.data.sources.length > 0 && (
              <details className="mt-1 text-xs text-neutral-400">
                <summary className="cursor-pointer">{t.data.sources.length} source passage(s)</summary>
                <ol className="list-decimal ml-5 mt-1 space-y-1">
                  {t.data.sources.map((s, k) => (
                    <li key={k}><span className="text-neutral-300">{s.filename}, p.{s.page} ({s.type})</span>: {s.text}</li>
                  ))}
                </ol>
              </details>
            )}
          </div>
        ))}
        {busy && <div className="text-xs text-neutral-500">Thinking…</div>}
        <div ref={end} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={docId ? "Ask about the selected document…" : "Ask across all parsed documents…"}
          className="flex-1 rounded-md bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm text-neutral-100"
        />
        <button type="submit" disabled={busy || !text.trim()} className="px-3 py-2 rounded-md bg-sky-600 text-white text-sm disabled:opacity-50 flex items-center gap-1">
          <Send className="w-4 h-4" /> Ask
        </button>
      </form>
    </div>
  );
};
