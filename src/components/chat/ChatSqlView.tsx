import React, { useState } from "react";
import {
  Send,
  Code,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Link2,
} from "lucide-react";
import type { ChatSqlOutput } from "../../agents/24_chatSql";
import { askChatSql } from "../../agents/24_chatSql";
import { LockedCell } from "../common/LockedCell";
import { useEvidence } from "../../context/EvidenceContext";
import { ErrorAlert } from "../common/ErrorAlert";

interface ChatMessage {
  id: string;
  sender: "user" | "assistant";
  text?: string;
  data?: ChatSqlOutput;
}

export const ChatSqlView: React.FC = () => {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isAsking, setIsAsking] = useState(false);
  const { openEvidence } = useEvidence();

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || isAsking) return;

    const userText = question;
    setQuestion("");
    const userMsgId = `usr_${Date.now()}`;
    const assistantMsgId = `asst_${Date.now()}`;

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, sender: "user", text: userText },
    ]);

    setIsAsking(true);
    try {
      const result = await askChatSql({ question: userText });
      setMessages((prev) => [
        ...prev,
        { id: assistantMsgId, sender: "assistant", data: result },
      ]);
    } catch (err: unknown) {
      setMessages((prev) => [
        ...prev,
        {
          id: assistantMsgId,
          sender: "assistant",
          data: {
            conversation_id: "err_conv",
            decision: "BLOCK",
            reason: (err as Error).message,
            error: {
              code: "CHAT_SQL_EXECUTION_FAILURE",
              message: (err as Error).message,
            },
          },
        },
      ]);
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <div className="flex flex-col h-[700px] bg-neutral-950/70 border border-neutral-800 rounded-xl overflow-hidden text-xs">
      {/* Header */}
      <div className="px-5 py-3 border-b border-neutral-800 bg-neutral-900/60 flex items-center justify-between">
        <div>
          <div className="font-semibold text-neutral-100 text-sm">
            Governed SQL Assistant
          </div>
          <div className="text-[11px] text-neutral-400">
            Natural language inquiries translated to governed SQL with column-level policy checking.
          </div>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-6 text-neutral-500">
            <p className="text-sm font-medium text-neutral-400">
              No inquiries submitted yet.
            </p>
            <p className="text-xs text-neutral-500 mt-1 max-w-sm">
              Ask questions about documents, comparisons, and facts. All SQL queries pass through authorization guardrails.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${
                msg.sender === "user" ? "items-end" : "items-start"
              }`}
            >
              {msg.sender === "user" ? (
                <div className="bg-sky-600 text-white px-4 py-2.5 rounded-xl rounded-tr-none max-w-md shadow-sm">
                  {msg.text}
                </div>
              ) : (
                <div className="w-full max-w-2xl bg-neutral-900/90 border border-neutral-800 rounded-xl p-4 space-y-3">
                  {/* Decision Badge */}
                  {msg.data?.decision && (
                    <div className="flex items-center gap-2">
                      {msg.data.decision === "ALLOW" && (
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-mono text-[11px]">
                          <ShieldCheck className="w-3.5 h-3.5" />
                          <span>ALLOW (Permitted Query)</span>
                        </div>
                      )}
                      {msg.data.decision === "CONFIRM" && (
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-500/10 border border-amber-500/20 text-amber-300 font-mono text-[11px]">
                          <ShieldAlert className="w-3.5 h-3.5" />
                          <span>CONFIRM (Requires Elevation Approval)</span>
                        </div>
                      )}
                      {msg.data.decision === "BLOCK" && (
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-rose-500/10 border border-rose-500/20 text-rose-400 font-mono text-[11px]">
                          <ShieldX className="w-3.5 h-3.5" />
                          <span>BLOCK (Restricted by Access Policy)</span>
                        </div>
                      )}
                      {msg.data.reason && (
                        <span className="text-neutral-400 text-[11px]">
                          {msg.data.reason}
                        </span>
                      )}
                    </div>
                  )}

                  {/* SQL Statement & Analysis Chips */}
                  {msg.data?.sql && (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2 text-[11px] text-neutral-400">
                        <Code className="w-3.5 h-3.5 text-neutral-500" />
                        <span>Generated SQL</span>
                        {msg.data.analysis && (
                          <div className="flex items-center gap-1.5 ml-auto">
                            <span className="px-1.5 py-0.5 rounded bg-neutral-950 font-mono text-[10px] text-neutral-300">
                              {msg.data.analysis.operation}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-neutral-950 font-mono text-[10px] text-neutral-300">
                              Tables: {msg.data.analysis.tables.join(", ")}
                            </span>
                          </div>
                        )}
                      </div>
                      <pre className="p-2.5 bg-neutral-950 rounded border border-neutral-800 font-mono text-[11px] text-sky-300 overflow-x-auto">
                        {msg.data.sql}
                      </pre>
                    </div>
                  )}

                  {/* Error Alert */}
                  {msg.data?.error && (
                    <ErrorAlert error={msg.data.error} />
                  )}

                  {/* Tabular Result Set */}
                  {msg.data?.columns && msg.data?.rows && msg.data.rows.length > 0 && (
                    <div className="overflow-x-auto border border-neutral-800 rounded-lg">
                      <table className="w-full border-collapse text-left font-mono text-[11px]">
                        <thead>
                          <tr className="bg-neutral-950/80 border-b border-neutral-800 text-neutral-400">
                            {msg.data.columns.map((col, idx) => (
                              <th key={idx} className="p-2 font-medium">
                                {col.name}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {msg.data.rows.map((row, rIdx) => (
                            <tr
                              key={rIdx}
                              className="border-b border-neutral-800/40 hover:bg-neutral-800/30 text-neutral-300"
                            >
                              {row.map((val, cIdx) => {
                                const isLocked = msg.data?.columns?.[cIdx]?.locked;
                                return (
                                  <td key={cIdx} className="p-2">
                                    {isLocked ? (
                                      <LockedCell compact label="Restricted" />
                                    ) : (
                                      String(val ?? "—")
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Answer Text */}
                  {msg.data?.answer_text && (
                    <div className="text-neutral-200 text-xs leading-relaxed">
                      {msg.data.answer_text}
                    </div>
                  )}

                  {/* Citations */}
                  {msg.data?.citations && msg.data.citations.length > 0 && (
                    <div className="pt-2 border-t border-neutral-800/80 flex flex-wrap items-center gap-2">
                      <span className="text-[10px] text-neutral-500 font-medium">
                        Evidence Citations:
                      </span>
                      {msg.data.citations.map((cite, idx) => (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => openEvidence(cite)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-950 hover:bg-neutral-800 border border-neutral-800 text-sky-400 hover:text-sky-300 font-mono text-[10px] transition-colors"
                        >
                          <Link2 className="w-2.5 h-2.5" />
                          <span>{cite.filename || cite.source_id} p.{cite.page_number}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Input Bar */}
      <form
        onSubmit={handleSend}
        className="p-3 border-t border-neutral-800 bg-neutral-900/60 flex items-center gap-2"
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a natural language question about case facts, discrepancies, or documents..."
          disabled={isAsking}
          className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg px-3.5 py-2 text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-700 text-xs"
        />
        <button
          type="submit"
          disabled={isAsking || !question.trim()}
          className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Ask</span>
        </button>
      </form>
    </div>
  );
};
