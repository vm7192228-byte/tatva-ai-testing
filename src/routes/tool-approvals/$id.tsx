import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

type ApprovalView = {
  id: string;
  label: string;
  description: string;
  destructive: boolean;
  preview: Record<string, unknown>;
  status: string;
  createdAt: string;
  expiresAt: string;
  result?: { message?: string; platformStatus?: number } | null;
};

type ApiPayload = {
  ok?: boolean;
  approval?: ApprovalView;
  error?: string;
  status?: string;
  message?: string;
};

export const Route = createFileRoute("/tool-approvals/$id")({
  head: () => ({
    meta: [
      { title: "Review action — Dhwani AI" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ToolApprovalPage,
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return value.join(", ");
  return "";
}

function ToolApprovalPage() {
  const { id } = Route.useParams();
  return <ToolApprovalPageView id={id} />;
}

export function ToolApprovalPageView({ id }: { id: string }) {
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    void fetch("/api/tool-approvals/" + encodeURIComponent(id), {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    }).then(async response => {
      const payload = await response.json().catch(() => ({})) as ApiPayload;
      if (!response.ok || !payload.approval) {
        const message = payload.error === "AUTH_REQUIRED"
          ? "Sign in to the same Dhwani account that created this approval, then reopen this link."
          : payload.message || "This approval could not be loaded.";
        throw new Error(message);
      }
      if (active) setApproval(payload.approval);
    }).catch(reason => {
      if (active && reason instanceof Error && reason.name !== "AbortError") setError(reason.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [id]);

  const canDecide = useMemo(() => {
    return Boolean(approval && approval.status === "pending" &&
      Number.isFinite(Date.parse(approval.expiresAt)) &&
      Date.parse(approval.expiresAt) > Date.now());
  }, [approval]);

  async function decide(decision: "approve" | "reject") {
    if (!approval || busy || !canDecide) return;
    if (decision === "approve" && approval.destructive) {
      const confirmed = window.confirm(
        "This permanently deletes the selected YouTube video. Confirm only if you are certain."
      );
      if (!confirmed) return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        "/api/tool-approvals/" + encodeURIComponent(id) + "/" + decision,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(approval.destructive && decision === "approve" ? { confirmDelete: true } : {}),
        }
      );
      const payload = await response.json().catch(() => ({})) as ApiPayload;
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.message || payload.error || "The action could not be completed.");
      }
      setApproval(current => current ? {
        ...current,
        status: payload.status || (decision === "approve" ? "executed" : "rejected"),
        result: { message: payload.message || "The decision was saved." },
      } : current);
      setNotice(payload.message || (decision === "approve" ? "The action was approved." : "The action was rejected."));
    } catch (reason) {
      const isNetworkFailure = reason instanceof TypeError ||
        (typeof reason === "object" && reason !== null &&
          "name" in reason && (reason as { name?: unknown }).name === "TypeError");
      if (isNetworkFailure) {
        setApproval(current => current ? {
          ...current,
          status: "uncertain",
          result: { message: "The outcome could not be verified. Check your connected account before trying again." },
        } : current);
        setError("The outcome could not be verified. Check your connected account before trying again.");
      } else {
        const message = reason instanceof Error ? reason.message : "The action could not be completed.";
        setError(message);
        if (message.toLowerCase().includes("check your connected account")) {
          setApproval(current => current ? { ...current, status: "uncertain" } : current);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const previewRows = approval
    ? Object.entries(approval.preview).map(([key, value]) => ({ key, value: displayValue(value) })).filter(item => item.value)
    : [];

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12 text-slate-900">
      <div className="mx-auto w-full max-w-xl">
        <a href="/" className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-slate-900">
          <span aria-hidden="true">←</span> Dhwani AI
        </a>
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-blue-600">Action approval</div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Review before Dhwani acts</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Nothing is sent to a social platform until the signed-in account owner approves this exact request.
          </p>

          {loading ? (
            <p className="mt-8 text-sm text-slate-500" role="status">Loading approval details…</p>
          ) : error && !approval ? (
            <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900" role="alert">
              {error}
              <p className="mt-2">No action has been executed from this page.</p>
            </div>
          ) : approval ? (
            <>
              <div className="mt-7 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-semibold">{approval.label}</h2>
                  <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-semibold capitalize text-slate-700">
                    {approval.status.replaceAll("_", " ")}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-600">{approval.description}</p>
                {previewRows.length > 0 && (
                  <dl className="mt-4 divide-y divide-slate-200">
                    {previewRows.map(item => (
                      <div key={item.key} className="grid grid-cols-[110px_1fr] gap-3 py-2 text-sm">
                        <dt className="font-medium capitalize text-slate-500">{item.key.replaceAll(/([A-Z])/g, " $1")}</dt>
                        <dd className="min-w-0 whitespace-pre-wrap break-words text-slate-800">{item.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <div className="mt-4 grid gap-1 text-xs text-slate-500">
                  <div>Created: {formatDate(approval.createdAt)}</div>
                  <div>Expires: {formatDate(approval.expiresAt)}</div>
                </div>
              </div>

              {approval.destructive && (
                <div className="mt-4 rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm leading-6 text-orange-900">
                  This action is destructive and cannot be undone. The approve button will ask for a second confirmation.
                </div>
              )}

              {notice && <p className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{notice}</p>}
              {error && <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-800" role="alert">{error}</p>}

              {canDecide ? (
                <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide("reject")}
                    className="min-h-11 flex-1 rounded-full border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? "Please wait…" : "Reject"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide("approve")}
                    className="min-h-11 flex-1 rounded-full bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? "Please wait…" : approval.destructive ? "Confirm and approve" : "Approve action"}
                  </button>
                </div>
              ) : (
                <p className="mt-6 rounded-lg bg-slate-100 p-3 text-sm text-slate-600">
                  This approval is no longer pending. It cannot be reused or executed again.
                </p>
              )}
              <p className="mt-5 text-xs leading-5 text-slate-500">
                The connected platform still checks account ownership, permissions and usage limits when the action is approved.
              </p>
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}
