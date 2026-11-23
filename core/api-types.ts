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

export interface FindingView extends Finding {
  id: string;
  standardTitle: string | null;
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
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  standards: SnapshotEntry[];
  findings: FindingView[];
  events: ReviewEvent[];
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
