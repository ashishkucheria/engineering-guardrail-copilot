import { useEffect, useState } from "react";
import { api, type DashboardView } from "../api.ts";

const pct = (r: number) => `${Math.round(r * 100)}%`;

export function DashboardPage() {
  const [d, setD] = useState<DashboardView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dashboard().then(setD).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!d) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <section className="card">
        <h2>Dashboard</h2>
        <p className="muted small">Counts over every review in this demo's database, read live from D1.</p>
        <div className="tiles">
          <Tile label="Reviews" value={d.totalReviews} />
          <Tile label="Pass" value={d.verdicts.pass} />
          <Tile label="Pass with warnings" value={d.verdicts.warn} />
          <Tile label="Fail" value={d.verdicts.fail} />
          <Tile label="Incomplete" value={d.verdicts.incomplete} />
        </div>
      </section>

      <section className="card">
        <h3>Findings</h3>
        <div className="tiles">
          <Tile label="Blocker violations" value={d.violationsBySeverity.blocker} />
          <Tile label="Major violations" value={d.violationsBySeverity.major} />
          <Tile label="Minor violations" value={d.violationsBySeverity.minor} />
          <Tile label="Suggestions" value={d.suggestions} />
          <Tile label="Waived by exceptions" value={d.waived} />
        </div>
        <p className="muted small">Violation counts leave out findings waived by an exception.</p>
        {d.topStandards.length > 0 && (
          <table className="table compact">
            <thead>
              <tr><th>Most frequent standards</th><th>Findings</th></tr>
            </thead>
            <tbody>
              {d.topStandards.map((s) => (
                <tr key={s.id}><td><strong>{s.id}</strong> {s.title}</td><td>{s.count}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h3>Feedback and challenges</h3>
        <div className="tiles">
          <Tile label="Accepted" value={d.dispositions.accepted} />
          <Tile label="Rejected" value={d.dispositions.rejected} />
          <Tile label="No feedback yet" value={d.dispositions.open} />
          <Tile label="Challenges upheld" value={d.challenges.upheld} />
          <Tile label="Disputed by the author" value={d.challenges.disputed} />
        </div>
        <p className="muted small">
          "Accepted" is the closest the app gets to "remediated": it can't see whether a fix landed. "Disputed by the author" means the author's
          argument persuaded the AI: a signal worth reviewing, not a confirmed false positive.
        </p>
        {d.rejectRateByStandard.length > 0 && (
          <table className="table compact">
            <thead>
              <tr><th>Reject rate by standard</th><th>Rejected</th><th>Findings with feedback</th></tr>
            </thead>
            <tbody>
              {d.rejectRateByStandard.map((r) => (
                <tr key={r.id}><td><strong>{r.id}</strong></td><td>{pct(r.rate)}</td><td>{r.n}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h3>Exceptions and AI budget</h3>
        <div className="tiles">
          <Tile label="Pending" value={d.exceptions.pending} />
          <Tile label="Active" value={d.exceptions.active} />
          <Tile label="Expired" value={d.exceptions.expired} />
          <Tile label="Denied" value={d.exceptions.denied} />
          <Tile label={`AI calls today (${d.budget.day})`} value={`${d.budget.app.used} / ${d.budget.app.limit}`} />
        </div>
      </section>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="tile">
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}
