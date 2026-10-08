import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, FileText, Globe2, LockKeyhole, Send, X } from "lucide-react";
import {
  decideDocumentAccess,
  fetchAccessDocuments,
  fetchDocumentAccessRequests,
  requestDocumentAccess,
  setDocumentVisibility,
} from "../../agents/23_accessControl";
import { useAuth } from "../../context/AuthContext";
import { Modal } from "../common/Modal";

export const DocumentAccessPanel: React.FC = () => {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const docsQuery = useQuery({
    queryKey: ["accessDocuments"],
    queryFn: ({ signal }) => fetchAccessDocuments(signal),
  });
  const requestsQuery = useQuery({
    queryKey: ["documentAccessRequests", user?.role],
    queryFn: ({ signal }) => fetchDocumentAccessRequests(signal),
    enabled: isAdmin || user?.role === "viewer",
    refetchInterval: isAdmin || user?.role === "viewer" ? 10000 : false,
  });
  const requests = requestsQuery.data?.requests ?? [];
  const pendingFor = (sourceId: string) =>
    requests.some((request) => request.source_id === sourceId && request.status === "pending");

  const submitRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || reason.trim().length < 3) return;
    setBusy(selected.id);
    setError(null);
    try {
      await requestDocumentAccess({ source_id: selected.id, reason: reason.trim() });
      setSelected(null);
      setReason("");
      await requestsQuery.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit access request");
    } finally {
      setBusy(null);
    }
  };

  const decide = async (requestId: string, decision: "approve" | "reject") => {
    setBusy(requestId);
    setError(null);
    try {
      await decideDocumentAccess({ request_id: requestId, decision });
      await Promise.all([requestsQuery.refetch(), docsQuery.refetch()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not decide access request");
    } finally {
      setBusy(null);
    }
  };

  const updateVisibility = async (sourceId: string, visibility: "public" | "private") => {
    setBusy(sourceId);
    setError(null);
    try {
      await setDocumentVisibility({ source_id: sourceId, visibility });
      await docsQuery.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update document visibility");
      await docsQuery.refetch();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-100">Documents in Local Storage</h2>
          <p className="mt-1 text-[11px] text-neutral-400">
            {isAdmin
              ? "Review local documents and any viewer access requests below."
              : "Request admin approval before opening a locally stored document."}
          </p>
        </div>
        {error && <div role="alert" className="rounded border border-rose-800 bg-rose-950/30 p-2 text-rose-300">{error}</div>}
        {docsQuery.isLoading && <div className="text-neutral-400">Loading local documents…</div>}
        {docsQuery.isError && <div role="alert" className="text-rose-300">Could not load the local document catalog: {docsQuery.error.message}</div>}
        {!docsQuery.isLoading && !docsQuery.isError && !docsQuery.data?.documents.length && (
          <div className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-5 text-center text-neutral-400">No accepted documents are stored locally.</div>
        )}
        <div className="space-y-2">
          {docsQuery.data?.documents.map((document) => (
            <div key={document.source_id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-sky-400" />
                <div className="min-w-0">
                  <div className="truncate font-medium text-neutral-200">{document.filename}</div>
                  <div className="font-mono text-[10px] text-neutral-500">{document.source_id} · {document.kind}</div>
                </div>
              </div>
              {isAdmin ? (
                <label className="flex items-center gap-2 text-[11px] text-neutral-300">
                  {document.visibility === "public"
                    ? <Globe2 className="h-3.5 w-3.5 text-emerald-400" />
                    : <LockKeyhole className="h-3.5 w-3.5 text-amber-300" />}
                  <span className="sr-only">Visibility for {document.filename}</span>
                  <select
                    aria-label={`Visibility for ${document.filename}`}
                    value={document.visibility}
                    disabled={busy === document.source_id}
                    onChange={(event) => updateVisibility(document.source_id, event.target.value === "public" ? "public" : "private")}
                    className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200 disabled:opacity-50"
                  >
                    <option value="private">Private — approval required</option>
                    <option value="public">Public — all tenant viewers</option>
                  </select>
                </label>
              ) : document.has_access ? (
                <Link to={`/dashboard?source_id=${encodeURIComponent(document.source_id)}`}
                  className="inline-flex items-center gap-1 text-[11px] text-emerald-400 hover:underline">
                  {document.visibility === "public"
                    ? <Globe2 className="h-3.5 w-3.5" />
                    : <Check className="h-3.5 w-3.5" />}
                  {document.visibility === "public" ? "Open public document" : "Open approved document"}
                </Link>
              ) : pendingFor(document.source_id) ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-amber-300"><LockKeyhole className="h-3.5 w-3.5" /> Request pending</span>
              ) : (
                <button
                  type="button"
                  onClick={() => { setSelected({ id: document.source_id, name: document.filename }); setError(null); }}
                  className="inline-flex items-center gap-1 rounded border border-sky-800 px-3 py-1.5 text-sky-300 hover:bg-sky-950/30"
                >
                  <Send className="h-3.5 w-3.5" /> Request access
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3 border-t border-neutral-800 pt-5">
        <h2 className="text-sm font-semibold text-neutral-100">
          {isAdmin ? "Viewer Document Requests" : "My Document Requests"}
        </h2>
        {requestsQuery.isError && <div role="alert" className="text-rose-300">Could not load access requests: {requestsQuery.error.message}</div>}
        {!requestsQuery.isLoading && !requestsQuery.isError && requests.length === 0 && (
          <div className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-4 text-neutral-400">No document access requests.</div>
        )}
        {requests.map((request) => (
          <article key={request.request_id} className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-medium text-neutral-200">{request.filename}</div>
                <div className="font-mono text-[10px] text-neutral-500">
                  {request.source_id} · {request.user_id} · {request.request_id}
                </div>
              </div>
              <span className={`rounded border px-2 py-1 text-[10px] uppercase ${
                request.status === "approved" ? "border-emerald-800 text-emerald-300" :
                  request.status === "rejected" ? "border-rose-800 text-rose-300" :
                    "border-amber-800 text-amber-300"
              }`}>{request.status}</span>
            </div>
            <p className="text-neutral-300">{request.reason}</p>
            {request.notes && <p className="text-[11px] text-neutral-400">Admin note: {request.notes}</p>}
            {isAdmin && request.status === "pending" && (
              <div className="flex justify-end gap-2 border-t border-neutral-800 pt-2">
                <button type="button" onClick={() => decide(request.request_id, "reject")} disabled={busy === request.request_id}
                  className="inline-flex items-center gap-1 rounded border border-rose-800 px-3 py-1.5 text-rose-300 disabled:opacity-50">
                  <X className="h-3.5 w-3.5" /> Reject
                </button>
                <button type="button" onClick={() => decide(request.request_id, "approve")} disabled={busy === request.request_id}
                  className="inline-flex items-center gap-1 rounded bg-emerald-700 px-3 py-1.5 text-white disabled:opacity-50">
                  <Check className="h-3.5 w-3.5" /> Approve
                </button>
              </div>
            )}
          </article>
        ))}
      </section>

      <Modal isOpen={Boolean(selected)} onClose={() => setSelected(null)} title={`Request document access`} maxWidth="md">
        <form onSubmit={submitRequest} className="space-y-4 text-xs">
          <p className="text-neutral-300">{selected?.name}</p>
          <label className="block text-neutral-300">
            Reason for access
            <textarea autoFocus required minLength={3} maxLength={2000} value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-neutral-100"
              rows={4} placeholder="Explain why you need this document." />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setSelected(null)} className="rounded px-3 py-1.5 text-neutral-300 hover:bg-neutral-800">Cancel</button>
            <button type="submit" disabled={Boolean(busy) || reason.trim().length < 3}
              className="inline-flex items-center gap-1 rounded bg-sky-700 px-3 py-1.5 text-white disabled:opacity-50">
              <Send className="h-3.5 w-3.5" /> Submit request
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
