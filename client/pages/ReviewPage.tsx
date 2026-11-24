import { useEffect, useState } from "react";
import { api, type MetaView } from "../api.ts";
import { SAMPLES } from "../samples.ts";
import { ReviewResult } from "../components/ReviewResult.tsx";
import { useReview } from "../useReview.ts";

const MAX_BYTES = 100_000;

export function ReviewPage({ onOpen }: { onOpen: (id: string) => void }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [meta, setMeta] = useState<MetaView | null>(null);
  const { review, error: loadError, reload } = useReview(reviewId);
  const bytes = new TextEncoder().encode(input).byteLength;
  const running = !!reviewId && (!review || review.status === "queued" || review.status === "running");

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setMeta(null));
  }, [review?.status]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      setReviewId((await api.createReview(input)).id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="row spread">
          <h2>Submit code for review</h2>
          <div className="row">
            {SAMPLES.map((s) => (
              <button key={s.label} className="ghost" onClick={() => { setInput(s.input); setReviewId(null); }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <p className="muted">Paste a code snippet or a unified diff (for example the output of <code>git diff</code>).</p>
        <textarea
          className="code-input"
          spellCheck={false}
          wrap="off"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="diff --git a/src/app.ts b/src/app.ts …"
        />
        <div className="row spread">
          <span className={bytes > MAX_BYTES ? "error-text" : "muted"}>
            {(bytes / 1000).toFixed(1)} / {MAX_BYTES / 1000} KB
          </span>
          <button className="primary" disabled={busy || running || !input.trim() || bytes > MAX_BYTES} onClick={submit}>
            {busy || running ? "Reviewing…" : "Review"}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {meta && <AiStatus meta={meta} />}
      </section>
      {loadError && <div className="error">{loadError}</div>}
      {reviewId && !review && !loadError && <p className="muted">Starting the review…</p>}
      {review && (
        <>
          <ReviewResult review={review} onChanged={reload} />
          <button className="ghost" onClick={() => onOpen(review.id)}>Open in history →</button>
        </>
      )}
    </div>
  );
}

function AiStatus({ meta }: { meta: MetaView }) {
  const { used, limit } = meta.budget.app;
  if (meta.llmMode === "off") return <p className="muted small">AI review is off: only the deterministic checks run, so reviews with AI standards are "incomplete".</p>;
  return (
    <p className="muted small">
      Deterministic checks plus AI review ({meta.llmMode === "fake" ? "fake model for testing" : meta.model}, prompt {meta.promptVersion}). AI calls
      today: {used} of {limit}
      {used >= limit ? ". The daily budget is used up: new reviews run the deterministic checks only and are marked incomplete." : "."}
    </p>
  );
}
