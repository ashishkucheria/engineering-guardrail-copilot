import { useEffect, useState } from "react";
import { api, type ReviewSummary } from "../api.ts";
import { ReviewResult, VerdictBadge } from "../components/ReviewResult.tsx";
import { useReview } from "../useReview.ts";

export function HistoryPage({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const [list, setList] = useState<ReviewSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { review: detail, error: detailError, reload } = useReview(openId);

  useEffect(() => {
    api.reviews().then(setList).catch((e: Error) => setError(e.message));
  }, []);

  if (openId) {
    return (
      <div className="stack">
        <button className="ghost" onClick={() => onOpen(null)}>← All reviews</button>
        {detailError && <div className="error">{detailError}</div>}
        {!detail && !detailError && <p className="muted">Loading…</p>}
        {detail && (
          <>
            <ReviewResult review={detail} showSnapshot onChanged={reload} />
            <section className="card">
              <h3>Submitted input</h3>
              <pre className="evidence scroll">{detail.inputText}</pre>
            </section>
          </>
        )}
      </div>
    );
  }

  return (
    <section className="card">
      <h2>Review history</h2>
      {error && <div className="error">{error}</div>}
      {list && list.length === 0 && <p className="muted">No reviews yet.</p>}
      {list && list.length > 0 && (
        <table className="table">
          <thead>
            <tr><th>When</th><th>Author</th><th>Input</th><th>Verdict</th><th>Findings</th></tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.author.name}</td>
                <td>{r.inputKind}</td>
                <td><VerdictBadge verdict={r.verdict} status={r.status} /></td>
                <td>{r.findingCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
