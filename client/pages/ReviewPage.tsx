import { useState } from "react";
import { api, type ReviewDetail } from "../api.ts";
import { SAMPLES } from "../samples.ts";
import { ReviewResult } from "../components/ReviewResult.tsx";

const MAX_BYTES = 100_000;

export function ReviewPage({ onOpen }: { onOpen: (id: string) => void }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReviewDetail | null>(null);
  const bytes = new TextEncoder().encode(input).byteLength;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.createReview(input));
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
              <button key={s.label} className="ghost" onClick={() => { setInput(s.input); setResult(null); }}>
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
          <button className="primary" disabled={busy || !input.trim() || bytes > MAX_BYTES} onClick={submit}>
            {busy ? "Reviewing…" : "Review"}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        <p className="muted small">
          This build runs the deterministic checks only. AI review arrives in the next PR.
        </p>
      </section>
      {result && (
        <>
          <ReviewResult review={result} />
          <button className="ghost" onClick={() => onOpen(result.id)}>Open in history →</button>
        </>
      )}
    </div>
  );
}
