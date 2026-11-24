// Response shapes of the HTTP API, shared by the Worker (which produces them) and the React client.
import type { Coverage, Finding, Standard, StandardSnapshot, Verdict } from "./types.ts";

export interface Ref {
  id: string;
  name: string;
}

export interface StandardView extends Standard {
  /** Last person to enable/disable it. Null if never changed since seeding. */
  updatedBy: Ref | null;
  updatedAt: string;
  /** Set when the standard's YAML file was removed. A retired standard never runs and can't be toggled. */
  retiredAt: string | null;
}

export interface StandardChange {
  id: number;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: Ref;
  changedAt: string;
}

export interface ReviewSummary {
  id: string;
  author: Ref;
  inputKind: string;
  status: string;
  verdict: Verdict | null;
  findingCount: number;
  createdAt: string;
}

export interface SnapshotEntry extends StandardSnapshot {
  /** The standard as it read when the review ran, from standard_versions. */
  title: string | null;
  rule: string | null;
  /** Whether the standard has changed (content or status) since this review. */
  changedSince: { content: boolean; enabled: boolean };
}

export interface ChallengeView {
  by: Ref;
  argument: string;
  /** The model's assessment, as given. For rule findings the outcome is "upheld" whatever it says. */
  assessment: string | null;
  reasoning: string | null;
  at: string;
}

export interface FindingView extends Finding {
  id: string;
  standardTitle: string | null;
  preExisting: boolean;
  /** "disputed" means the author's argument persuaded the AI. It never changes classification, severity or the verdict. */
  challengeOutcome: "upheld" | "disputed" | null;
  challenge: ChallengeView | null;
  /** Latest accept/reject. Never affects detection or the verdict. */
  disposition: "open" | "accepted" | "rejected";
  /** The exception that waives this finding, if any. Waived findings don't count toward the verdict. */
  waiver: { id: string; pathPattern: string; decidedBy: Ref | null; expiresAt: string; revokedAt: string | null } | null;
  /** The latest exception requested from this finding, if any. */
  exceptionRequest: { id: string; status: ExceptionView["status"] } | null;
}

/** How a standard's findings fared in other reviews. Shown next to findings and in chat, never used by detection. */
export interface StandardHistoryView {
  standardId: string;
  accepted: number;
  rejected: number;
  disputed: number;
  recentReasons: { reason: string; by: Ref; at: string }[];
}

export interface ChatMessageView {
  id: number;
  role: "user" | "assistant";
  user: Ref | null;
  content: string;
  createdAt: string;
}

export interface ChatResult {
  reply: string;
  messages: ChatMessageView[];
}

export interface ExceptionView {
  id: string;
  standardId: string;
  standardTitle: string | null;
  pathPattern: string;
  justification: string;
  sourceFinding: { id: string; reviewId: string; file: string; lineStart: number } | null;
  requestedBy: Ref;
  status: "pending" | "approved" | "denied" | "revoked";
  /** Derived, never stored: approved exceptions are active until expiresAt, then expired. */
  state: "pending" | "active" | "expired" | "denied" | "revoked";
  decidedBy: Ref | null;
  decisionNote: string | null;
  /** Set when an approver ended an approved exception early. Past waivers stay. */
  revokedBy: Ref | null;
  revokedAt: string | null;
  revokeNote: string | null;
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface DashboardView {
  totalReviews: number;
  verdicts: Record<Verdict, number>;
  /** Violations not waived by an exception, by severity. */
  violationsBySeverity: { blocker: number; major: number; minor: number };
  suggestions: number;
  waived: number;
  topStandards: { id: string; title: string | null; count: number }[];
  /** "Accepted" is the closest the app gets to "remediated": it can't see whether a fix landed. */
  dispositions: { open: number; accepted: number; rejected: number };
  rejectRateByStandard: { id: string; rate: number; n: number }[];
  /** "disputed" means disputed by the author through a challenge: a signal, not a confirmed false positive. */
  challenges: { upheld: number; disputed: number };
  exceptions: { pending: number; active: number; expired: number; denied: number; revoked: number };
  budget: MetaView["budget"];
}

export interface ChallengeResult {
  assessment: "upheld" | "not_supported";
  reasoning: string;
  finding: FindingView;
}

export interface MetaView {
  llmMode: "workers-ai" | "fake" | "off";
  model: string | null;
  promptVersion: string;
  budget: { day: string; app: { used: number; limit: number }; eval: { used: number; limit: number } };
}

export interface ReviewEvent {
  step: string;
  outcome: string;
  durationMs: number | null;
  detail: string | null;
  at: string;
}

export interface ReviewDetail {
  id: string;
  author: Ref;
  inputKind: string;
  inputText: string;
  status: string;
  verdict: Verdict | null;
  coverage: Coverage | null;
  engine: string;
  promptVersion: string | null;
  model: string | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  standards: SnapshotEntry[];
  findings: FindingView[];
  events: ReviewEvent[];
  /** Whether the requesting user may challenge this review's findings (see canChallenge). */
  viewerCanChallenge: boolean;
  /** Whether the requesting user may accept/reject findings and request exceptions from them. */
  viewerCanGiveFeedback: boolean;
  /** Per standard with findings here: how its findings fared in other reviews. */
  history: StandardHistoryView[];
  messages: ChatMessageView[];
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
