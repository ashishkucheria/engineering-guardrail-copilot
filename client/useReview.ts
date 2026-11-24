import { useCallback, useEffect, useState } from "react";
import { api, ApiFailure, type ReviewDetail } from "./api.ts";

const POLL_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
/** Consecutive transient failures before the page says so (it keeps polling either way). */
const SHOW_ERROR_AFTER = 3;

/**
 * Loads a review and polls while the pipeline is still queued or running.
 *
 * A transient failure (network, 429, 5xx) doesn't stop polling: the review is still running on the
 * server. A 429 waits for its Retry-After, other transient errors back off exponentially (review of
 * PR #3, item 2). Only a permanent error (401, 403, 404) stops.
 */
export function useReview(id: string | null) {
  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    setError(null);
    if (!id) {
      setReview(null);
      return;
    }
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await api.review(id);
        if (stopped) return;
        failures = 0;
        setError(null);
        setReview(r);
        if (r.status === "queued" || r.status === "running") timer = setTimeout(load, POLL_MS);
      } catch (e) {
        if (stopped) return;
        const f = e instanceof ApiFailure ? e : null;
        if (!f?.transient) {
          setError((e as Error).message);
          return;
        }
        failures++;
        if (failures >= SHOW_ERROR_AFTER) setError(`${f.message} Still trying…`);
        const wait = f.retryAfter ? f.retryAfter * 1000 : Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS);
        timer = setTimeout(load, wait);
      }
    };
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, nonce]);

  return { review: review?.id === id ? review : null, error, reload };
}
