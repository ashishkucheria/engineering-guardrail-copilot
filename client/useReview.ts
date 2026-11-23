import { useCallback, useEffect, useState } from "react";
import { api, type ReviewDetail } from "./api.ts";

const POLL_MS = 1_500;

/** Loads a review and polls while the pipeline is still queued or running. */
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await api.review(id);
        if (stopped) return;
        setReview(r);
        if (r.status === "queued" || r.status === "running") timer = setTimeout(load, POLL_MS);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
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
