import { useState } from "react";
import { api, type ChatMessageView, type FindingView, type ReviewDetail, type StandardHistoryView } from "../api.ts";

const VERDICT_TEXT: Record<string, string> = {
  pass: "Pass",
  warn: "Pass with warnings",
  fail: "Fail",
  incomplete: "Incomplete",
};

export function VerdictBadge({ verdict, status }: { verdict: string | null; status?: string }) {
  if (status === "failed") return <span className="badge verdict-fail">Error</span>;
  if (!verdict) return <span className="badge">{status === "running" ? "running…" : "queued…"}</span>;
  return <span className={`badge verdict-${verdict}`}>{VERDICT_TEXT[verdict] ?? verdict}</span>;
}

export function ReviewResult({ review, showSnapshot = false, onChanged }: { review: ReviewDetail; showSnapshot?: boolean; onChanged?: () => void }) {
  const violations = review.findings.filter((f) => f.classification === "violation");
  const suggestions = review.findings.filter((f) => f.classification === "suggestion");
  const cov = review.coverage;
  const inProgress = review.status === "queued" || review.status === "running";

  return (
    <div className="stack">
      <section className="card">
        <div className="row spread">
          <div className="row">
            <VerdictBadge verdict={review.verdict} status={review.status} />
            <span className="muted">
              {review.inputKind}
              {cov ? ` · ${cov.filesReviewed} of ${cov.filesTotal} file(s) reviewed` : ""} · engine: {review.engine}
              {review.model ? ` · ${review.model}` : ""}
            </span>
          </div>
          <span className="muted small">
            by {review.author.name} · {new Date(review.createdAt).toLocaleString()}
          </span>
        </div>
        {inProgress && <p className="muted">The review is {review.status}. Steps appear below as they finish.</p>}
        {cov && cov.skipped.length > 0 && (
          <div className="warning">
            Not fully reviewed: {cov.skipped.map((s) => `${s.file} (${s.reason})`).join(", ")}. The verdict can't be
            "pass" while code is unread.
          </div>
        )}
        {review.error && <div className="error">The review failed: {review.error}</div>}
      </section>

      {!inProgress && review.status !== "failed" && (
        <>
          <FindingGroup title="Violations" empty="No violations." findings={violations} review={review} onChanged={onChanged} />
          {suggestions.length > 0 && <FindingGroup title="Suggestions" empty="" findings={suggestions} review={review} onChanged={onChanged} />}
          {!review.viewerCanChallenge && review.findings.length > 0 && (
            <p className="muted small">Only {review.author.name} (the author) or an approver can accept, reject, challenge or request exceptions for these findings, or chat about this review.</p>
          )}
          {review.findings.some((f) => f.challengeOutcome === "disputed") && (
            <p className="muted small">
              "Disputed" means the author's argument persuaded the AI. It's a signal, not a confirmed false positive, and the
              finding still counts toward the verdict: only an approved exception can waive a violation.
            </p>
          )}
          {/* Chat follows the feedback rule: the author or an approver (review of PR #4, item 3). */}
          {review.status === "complete" && review.viewerCanGiveFeedback && <ChatPanel review={review} onChanged={onChanged} />}
        </>
      )}

      {review.events.length > 0 && (
        <section className="card">
          <h3>Pipeline</h3>
          <table className="table compact">
            <tbody>
              {review.events.map((e, i) => (
                <tr key={i}>
                  <td><code>{e.step}</code></td>
                  <td><span className={`pill outcome-${e.outcome}`}>{e.outcome}</span></td>
                  <td className="muted">{e.durationMs != null ? `${e.durationMs} ms` : ""}</td>
                  <td>{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {showSnapshot && (
        <section className="card">
          <h3>Standards at review time</h3>
          <p className="muted small">
            The version and status of every standard when this review ran. Later changes don't rewrite history.
          </p>
          <table className="table compact">
            <thead>
              <tr><th>Standard</th><th>Version</th><th>Severity</th><th>Status then</th><th>Since then</th></tr>
            </thead>
            <tbody>
              {review.standards.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.id}</strong> {s.title}</td>
                  <td><code>{s.contentHash.slice(0, 8)}</code></td>
                  <td><span className={`sev sev-${s.severity}`}>{s.severity}</span></td>
                  <td>{s.enabled ? "enabled" : "disabled"}</td>
                  <td className="muted small">
                    {[s.changedSince.content && "rule text changed", s.changedSince.enabled && "status changed"].filter(Boolean).join(", ") || "unchanged"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function FindingGroup({ title, empty, findings, review, onChanged }: { title: string; empty: string; findings: FindingView[]; review: ReviewDetail; onChanged?: () => void }) {
  return (
    <section className="card">
      <h3>
        {title} <span className="count">{findings.length}</span>
      </h3>
      {findings.length === 0 && <p className="muted">{empty}</p>}
      <div className="stack">
        {findings.map((f) => (
          <FindingCard
            key={f.id}
            f={f}
            canChallenge={review.viewerCanChallenge}
            canGiveFeedback={review.viewerCanGiveFeedback}
            history={review.history.find((h) => h.standardId === f.standardId) ?? null}
            onChanged={onChanged}
          />
        ))}
      </div>
    </section>
  );
}

function FindingCard({
  f,
  canChallenge,
  canGiveFeedback,
  history,
  onChanged,
}: {
  f: FindingView;
  canChallenge: boolean;
  canGiveFeedback: boolean;
  history: StandardHistoryView | null;
  onChanged?: () => void;
}) {
  return (
    <article className={`finding sev-border-${f.severity}${f.waiver ? " waived" : ""}`}>
      <header className="row spread">
        <div className="row">
          <span className={`sev sev-${f.severity}`}>{f.severity}</span>
          <strong>{f.standardId}</strong>
          <span>{f.standardTitle}</span>
          <span className={`pill source-${f.source}`} title={f.source === "rule" ? "Deterministic check" : "AI finding with verified evidence"}>
            {f.source === "rule" ? "RULE" : "AI"}
          </span>
          {f.preExisting && (
            <span className="pill" title="The evidence is only on lines this change doesn't touch, so it can't fail the change.">
              PRE-EXISTING
            </span>
          )}
          {f.waiver && <span className="pill waived-pill" title="Waived by an approved exception: it doesn't count toward the verdict.">WAIVED</span>}
          {f.challengeOutcome === "disputed" && <span className="pill disputed">Disputed by the author (challenge succeeded)</span>}
          {f.challengeOutcome === "upheld" && <span className="pill">Challenge: upheld</span>}
          {f.disposition !== "open" && <span className={`pill disposition-${f.disposition}`}>{f.disposition}</span>}
        </div>
        <code className="muted">
          {f.file}:{f.lineStart}
          {f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ""}
        </code>
      </header>
      <pre className="evidence">{f.evidence}</pre>
      <dl className="finding-body">
        <dt>Why</dt>
        <dd>{f.explanation}</dd>
        <dt>Impact</dt>
        <dd>{f.impact}</dd>
        <dt>Fix</dt>
        <dd>{f.remediation}</dd>
      </dl>
      {f.waiver && (
        <div className="small waiver-note">
          Waived by exception <code>{f.waiver.id}</code> for <code>{f.waiver.pathPattern}</code>
          {f.waiver.decidedBy ? `, approved by ${f.waiver.decidedBy.name}` : ""}
          {f.waiver.revokedAt
            ? `, revoked ${new Date(f.waiver.revokedAt).toLocaleDateString()} (this review stays waived; later reviews aren't)`
            : `, expires ${new Date(f.waiver.expiresAt).toLocaleDateString()}`}
          . It stays on record but doesn't count toward the verdict.
        </div>
      )}
      {history && <HistoryNote h={history} />}
      {canGiveFeedback && <FeedbackControls f={f} onChanged={onChanged} />}
      {canGiveFeedback && f.classification === "violation" && !f.waiver && <ExceptionControls f={f} onChanged={onChanged} />}
      {f.challenge ? <ChallengeRecord f={f} /> : canChallenge && <ChallengeForm f={f} onChanged={onChanged} />}
    </article>
  );
}

/** How this standard's findings fared in other reviews. Context for people; never used by detection. */
function HistoryNote({ h }: { h: StandardHistoryView }) {
  if (h.accepted + h.rejected + h.disputed === 0) return null;
  return (
    <details className="history small">
      <summary>
        In other reviews, {h.standardId} findings were accepted {h.accepted}×, rejected {h.rejected}× and disputed by the author {h.disputed}×.
      </summary>
      {h.recentReasons.length > 0 && (
        <ul className="log">
          {h.recentReasons.map((r, i) => (
            <li key={i}>
              "{r.reason}" ({r.by.name}, {new Date(r.at).toLocaleDateString()})
            </li>
          ))}
        </ul>
      )}
      <div className="muted">History is shown for context only. It never affects what is detected or the verdict.</div>
    </details>
  );
}

function FeedbackControls({ f, onChanged }: { f: FindingView; onChanged?: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(action: "accept" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await api.feedback(f.id, action, action === "reject" ? reason : undefined);
      setRejecting(false);
      setReason("");
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack tight">
      <div className="row">
        <button className="ghost small-button" disabled={busy || f.disposition === "accepted"} onClick={() => send("accept")}>
          Accept
        </button>
        <button className="ghost small-button" disabled={busy || rejecting} onClick={() => setRejecting(true)}>
          {f.disposition === "rejected" ? "Reject again" : "Reject"}
        </button>
        <span className="muted small">Feedback feeds the dashboard. It doesn't change the verdict.</span>
      </div>
      {rejecting && (
        <div className="row">
          <input className="text-input grow" placeholder="Why is this finding wrong or not worth fixing?" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
          <button className="primary small-button" disabled={busy || !reason.trim()} onClick={() => send("reject")}>
            Reject
          </button>
          <button className="ghost small-button" disabled={busy} onClick={() => setRejecting(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function ExceptionControls({ f, onChanged }: { f: FindingView; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [pattern, setPattern] = useState(f.file);
  const [days, setDays] = useState(30);
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (f.exceptionRequest?.status === "pending") {
    return (
      <div className="small muted">
        Exception <code>{f.exceptionRequest.id}</code> requested; waiting for an approver (see the Exceptions tab).
      </div>
    );
  }
  if (!open) {
    return (
      <div className="row">
        <button className="ghost small-button" onClick={() => setOpen(true)}>
          Request an exception
        </button>
        {f.exceptionRequest?.status === "denied" && <span className="muted small">The last request ({f.exceptionRequest.id}) was denied.</span>}
      </div>
    );
  }
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.requestException({ finding_id: f.id, standard_id: f.standardId, path_pattern: pattern, justification, expires_in_days: days });
      setOpen(false);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="challenge">
      <label className="small">
        Ask an approver to waive <strong>{f.standardId}</strong>. Once another approver approves it, this finding and the matching findings in this
        review stop counting toward the verdict, and so do matching findings in later reviews until it expires.
      </label>
      <div className="row">
        <label className="small">
          Paths{" "}
          <input className="text-input" value={pattern} onChange={(e) => setPattern(e.target.value)} title='A glob: * within a folder, ** across folders, "*" alone for every path.' />
        </label>
        <label className="small">
          Expires in <input className="num-input" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} /> days (at most 90)
        </label>
      </div>
      <textarea className="small-input" placeholder="Why is this safe? (at least 10 characters)" value={justification} maxLength={2000} onChange={(e) => setJustification(e.target.value)} />
      <div className="row">
        <button className="primary" disabled={busy || justification.trim().length < 10} onClick={submit}>
          {busy ? "Requesting…" : "Request exception"}
        </button>
        <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Advisory chat about this review. It can't change anything; the buttons on the findings do that. */
function ChatPanel({ review, onChanged }: { review: ReviewDetail; onChanged?: () => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<ChatMessageView[] | null>(null);
  const messages = sent && sent.length > review.messages.length ? sent : review.messages;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      setSent((await api.chat(review.id, message)).messages);
      setMessage("");
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3>Ask about this review</h3>
      <p className="muted small">
        The AI sees this review's findings, the standards involved, active exceptions and how these standards' findings fared in other reviews. It's
        advisory: it can't accept, reject, challenge or waive anything. Each question uses one call of today's AI budget; each person can ask 5 a day,
        and chat stops while the budget is nearly used up so reviews keep some calls.
      </p>
      {messages.length > 0 && (
        <div className="chat">
          {messages.map((m) => (
            <div key={m.id} className={`chat-msg chat-${m.role}`}>
              <div className="small muted">
                {m.role === "user" ? (m.user?.name ?? "someone") : "AI"} · {new Date(m.createdAt).toLocaleTimeString()}
              </div>
              <div className="chat-text">{m.content}</div>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <input
          className="text-input grow"
          placeholder="For example: has SEC-001 come up before? What's the quickest fix?"
          value={message}
          maxLength={1000}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && message.trim() && !busy) void submit();
          }}
        />
        <button className="primary" disabled={busy || !message.trim()} onClick={submit}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  );
}


function ChallengeRecord({ f }: { f: FindingView }) {
  const c = f.challenge!;
  return (
    <div className="challenge">
      <div className="small muted">
        Challenged by {c.by.name} · {new Date(c.at).toLocaleString()}
      </div>
      <div><strong>Argument:</strong> {c.argument}</div>
      <div>
        <strong>AI assessment:</strong> {c.assessment === "not_supported" ? "the finding is not supported" : "the finding holds"}. {c.reasoning}
      </div>
      {f.source === "rule" && <div className="small muted">Deterministic findings are always upheld; the AI only explains.</div>}
      <div className="small muted">The verdict is unchanged either way.</div>
    </div>
  );
}

function ChallengeForm({ f, onChanged }: { f: FindingView; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [argument, setArgument] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button className="ghost small-button" onClick={() => setOpen(true)}>
        Challenge this finding
      </button>
    );
  }
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.challenge(f.id, argument);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="challenge">
      <label className="small">
        Why is this finding wrong? An AI assesses the argument. A successful challenge marks the finding disputed but
        doesn't change the verdict.
      </label>
      <textarea className="small-input" value={argument} maxLength={2000} onChange={(e) => setArgument(e.target.value)} />
      <div className="row">
        <button className="primary" disabled={busy || !argument.trim()} onClick={submit}>
          {busy ? "Assessing…" : "Submit challenge"}
        </button>
        <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
