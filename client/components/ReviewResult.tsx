import type { FindingView, ReviewDetail } from "../api.ts";

const VERDICT_TEXT: Record<string, string> = {
  pass: "Pass",
  warn: "Pass with warnings",
  fail: "Fail",
  incomplete: "Incomplete",
};

export function VerdictBadge({ verdict }: { verdict: string | null }) {
  if (!verdict) return <span className="badge">pending</span>;
  return <span className={`badge verdict-${verdict}`}>{VERDICT_TEXT[verdict] ?? verdict}</span>;
}

export function ReviewResult({ review, showSnapshot = false }: { review: ReviewDetail; showSnapshot?: boolean }) {
  const violations = review.findings.filter((f) => f.classification === "violation");
  const suggestions = review.findings.filter((f) => f.classification === "suggestion");
  const cov = review.coverage;

  return (
    <div className="stack">
      <section className="card">
        <div className="row spread">
          <div className="row">
            <VerdictBadge verdict={review.verdict} />
            <span className="muted">
              {review.inputKind} · {cov ? `${cov.filesReviewed} of ${cov.filesTotal} file(s) reviewed` : ""} · engine: {review.engine}
            </span>
          </div>
          <span className="muted small">
            by {review.author.name} · {new Date(review.createdAt).toLocaleString()}
          </span>
        </div>
        {cov && cov.skipped.length > 0 && (
          <div className="warning">
            Not fully reviewed: {cov.skipped.map((s) => `${s.file} (${s.reason})`).join(", ")}. The verdict can't be
            "pass" while code is unread.
          </div>
        )}
        {review.error && <div className="error">{review.error}</div>}
      </section>

      <FindingGroup title="Violations" empty="No violations." findings={violations} />
      {suggestions.length > 0 && <FindingGroup title="Suggestions" empty="" findings={suggestions} />}

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

function FindingGroup({ title, empty, findings }: { title: string; empty: string; findings: FindingView[] }) {
  return (
    <section className="card">
      <h3>
        {title} <span className="count">{findings.length}</span>
      </h3>
      {findings.length === 0 && <p className="muted">{empty}</p>}
      <div className="stack">
        {findings.map((f) => (
          <FindingCard key={f.id} f={f} />
        ))}
      </div>
    </section>
  );
}

function FindingCard({ f }: { f: FindingView }) {
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
    </article>
  );
}
