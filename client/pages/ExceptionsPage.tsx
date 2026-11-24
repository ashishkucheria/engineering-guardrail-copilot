import { useCallback, useEffect, useState } from "react";
import { api, type ExceptionView, type User } from "../api.ts";

type Filter = ExceptionView["state"] | "all";
const FILTERS: Filter[] = ["pending", "active", "expired", "denied", "all"];

export function ExceptionsPage({ user, onOpenReview }: { user: User; onOpenReview: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>("pending");
  const [list, setList] = useState<ExceptionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .exceptions(filter === "all" ? undefined : filter)
      .then(setList)
      .catch((e: Error) => setError(e.message));
  }, [filter]);
  useEffect(load, [load]);

  return (
    <section className="card">
      <div className="row spread">
        <h2>Exceptions</h2>
        <div className="row">
          {FILTERS.map((f) => (
            <button key={f} className={filter === f ? "tab active" : "tab"} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>
      <p className="muted small">
        An approved, unexpired exception is the only thing that waives a violation. Only approvers decide, never on their own request, and every
        exception expires within 90 days. Request one from a violation in a review.
      </p>
      {error && <div className="error">{error}</div>}
      {list && list.length === 0 && <p className="muted">No {filter === "all" ? "" : `${filter} `}exceptions.</p>}
      <div className="stack">
        {list?.map((e) => <ExceptionCard key={e.id} e={e} user={user} onDecided={load} onOpenReview={onOpenReview} />)}
      </div>
    </section>
  );
}

function ExceptionCard({ e, user, onDecided, onOpenReview }: { e: ExceptionView; user: User; onDecided: () => void; onOpenReview: (id: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const why =
    e.status !== "pending"
      ? null
      : user.role !== "approver"
        ? "Only approvers can decide exceptions."
        : user.id === e.requestedBy.id
          ? "You requested this one, so another approver has to decide it."
          : null;

  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError(null);
    try {
      await api.decideException(e.id, decision, note || undefined);
      onDecided();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="finding">
      <header className="row spread">
        <div className="row">
          <code>{e.id}</code>
          <strong>{e.standardId}</strong>
          <span>{e.standardTitle}</span>
          <span className={`pill state-${e.state}`}>{e.state}</span>
        </div>
        <span className="muted small">
          paths <code>{e.pathPattern}</code> · expires {new Date(e.expiresAt).toLocaleDateString()}
        </span>
      </header>
      <div>{e.justification}</div>
      <div className="small muted">
        Requested by {e.requestedBy.name} · {new Date(e.createdAt).toLocaleString()}
        {e.sourceFinding && (
          <>
            {" "}
            · from a finding at {e.sourceFinding.file}:{e.sourceFinding.lineStart} (
            <button className="link" onClick={() => onOpenReview(e.sourceFinding!.reviewId)}>
              open review
            </button>
            )
          </>
        )}
      </div>
      {e.decidedBy && (
        <div className="small">
          {e.status === "approved" ? "Approved" : "Denied"} by {e.decidedBy.name} · {e.decidedAt ? new Date(e.decidedAt).toLocaleString() : ""}
          {e.decisionNote ? `: ${e.decisionNote}` : ""}
        </div>
      )}
      {e.status === "pending" && (
        <div className="row">
          {why ? (
            <span className="muted small">{why}</span>
          ) : (
            <>
              <input className="text-input grow" placeholder="Note (optional)" value={note} maxLength={1000} onChange={(x) => setNote(x.target.value)} />
              <button className="primary small-button" disabled={busy} onClick={() => decide("approve")}>
                Approve
              </button>
              <button className="ghost small-button" disabled={busy} onClick={() => decide("deny")}>
                Deny
              </button>
            </>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </article>
  );
}
