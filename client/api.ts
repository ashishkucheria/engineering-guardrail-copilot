// Typed client for the Worker API. The response types are the Worker's own types, so a contract
// change breaks the build instead of the page.
import type {
  ChallengeResult,
  ChatMessageView,
  ChatResult,
  DashboardView,
  ExceptionView,
  FindingView,
  MetaView,
  ReviewDetail,
  ReviewSummary,
  StandardChange,
  StandardHistoryView,
  StandardView,
} from "../core/api-types.ts";
import type { User } from "../core/types.ts";

export type { ChallengeResult, ChatMessageView, ChatResult, DashboardView, ExceptionView, FindingView, MetaView, ReviewDetail, ReviewSummary, StandardChange, StandardHistoryView, StandardView, User };

export interface ExceptionRequestBody {
  finding_id?: string;
  standard_id: string;
  path_pattern: string;
  justification: string;
  expires_in_days: number;
}

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  /** Seconds, from the Retry-After header of a 429 or 503. */
  readonly retryAfter: number | null;
  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
  /** Worth retrying: the network, rate limits and server-side failures. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
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
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new ApiFailure(res.status, data?.error?.code ?? "http_error", data?.error?.message ?? `Request failed (${res.status}).`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }
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
  feedback: (findingId: string, action: "accept" | "reject", reason?: string) => call<FindingView>("POST", `/api/findings/${encodeURIComponent(findingId)}/feedback`, { action, reason }),
  requestException: (body: ExceptionRequestBody) => call<ExceptionView>("POST", "/api/exceptions", body),
  exceptions: (state?: ExceptionView["state"]) => call<ExceptionView[]>("GET", `/api/exceptions${state ? `?status=${state}` : ""}`),
  decideException: (id: string, decision: "approve" | "deny", note?: string) => call<ExceptionView>("POST", `/api/exceptions/${encodeURIComponent(id)}/decision`, { decision, note }),
  chat: (reviewId: string, message: string) => call<ChatResult>("POST", `/api/reviews/${encodeURIComponent(reviewId)}/chat`, { message }),
  dashboard: () => call<DashboardView>("GET", "/api/dashboard"),
  reviews: () => call<ReviewSummary[]>("GET", "/api/reviews"),
  review: (id: string) => call<ReviewDetail>("GET", `/api/reviews/${encodeURIComponent(id)}`),
};
