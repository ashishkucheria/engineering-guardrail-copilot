// Typed client for the Worker API. The response types are the Worker's own types, so a contract
// change breaks the build instead of the page.
import type { ChallengeResult, FindingView, MetaView, ReviewDetail, ReviewSummary, StandardChange, StandardView } from "../core/api-types.ts";
import type { User } from "../core/types.ts";

export type { ChallengeResult, FindingView, MetaView, ReviewDetail, ReviewSummary, StandardChange, StandardView, User };

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let currentUser: string | null = null;
export function setApiUser(id: string | null) {
  currentUser = id;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (currentUser) headers["x-demo-user"] = currentUser;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiFailure(0, "network", "Could not reach the server.");
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) throw new ApiFailure(res.status, data?.error?.code ?? "http_error", data?.error?.message ?? `Request failed (${res.status}).`);
  return data as T;
}

export const api = {
  users: () => call<User[]>("GET", "/api/users"),
  standards: () => call<StandardView[]>("GET", "/api/standards"),
  standardChanges: (id: string) => call<StandardChange[]>("GET", `/api/standards/${encodeURIComponent(id)}/changes`),
  setStandardEnabled: (id: string, enabled: boolean) => call<StandardView>("PATCH", `/api/standards/${encodeURIComponent(id)}`, { enabled }),
  meta: () => call<MetaView>("GET", "/api/meta"),
  createReview: (input: string) => call<{ id: string; status: string }>("POST", "/api/reviews", { input }),
  challenge: (findingId: string, argument: string) => call<ChallengeResult>("POST", `/api/findings/${encodeURIComponent(findingId)}/challenge`, { argument }),
  reviews: () => call<ReviewSummary[]>("GET", "/api/reviews"),
  review: (id: string) => call<ReviewDetail>("GET", `/api/reviews/${encodeURIComponent(id)}`),
};
