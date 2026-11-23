import { useState } from "react";
import { api, type FindingView, type ReviewDetail } from "../api.ts";

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
          <FindingGroup title="Violations" empty="No violations." findings={violations} canChallenge={review.viewerCanChallenge} onChanged={onChanged} />
          {suggestions.length > 0 && <FindingGroup title="Suggestions" empty="" findings={suggestions} canChallenge={review.viewerCanChallenge} onChanged={onChanged} />}
          {!review.viewerCanChallenge && review.findings.length > 0 && (
            <p className="muted small">Only {review.author.name} (the author) or an approver can challenge these findings.</p>
          )}
          {review.findings.some((f) => f.challengeOutcome === "disputed") && (
            <p className="muted small">
              A disputed finding is a likely false positive. It still counts toward the verdict: only an approved exception
              (coming in the next PR) can waive a violation.
            </p>
          )}
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

function FindingGroup({ title, empty, findings, canChallenge, onChanged }: { title: string; empty: string; findings: FindingView[]; canChallenge: boolean; onChanged?: () => void }) {
  return (
    <section className="card">
      <h3>
        {title} <span className="count">{findings.length}</span>
      </h3>
      {findings.length === 0 && <p className="muted">{empty}</p>}
      <div className="stack">
        {findings.map((f) => (
          <FindingCard key={f.id} f={f} canChallenge={canChallenge} onChanged={onChanged} />
        ))}
      </div>
    </section>
  );
}

function FindingCard({ f, canChallenge, onChanged }: { f: FindingView; canChallenge: boolean; onChanged?: () => void }) {
  return (
    <article className={`finding sev-border-${f.severity}`}>
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
          {f.challengeOutcome === "disputed" && <span className="pill disputed">Disputed (challenge succeeded)</span>}
          {f.challengeOutcome === "upheld" && <span className="pill">Challenge: upheld</span>}
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
      {f.challenge ? <ChallengeRecord f={f} /> : canChallenge && <ChallengeForm f={f} onChanged={onChanged} />}
    </article>
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
