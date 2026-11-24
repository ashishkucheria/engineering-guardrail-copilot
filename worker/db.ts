// D1 access. All SQL lives here, always with bound parameters.
import type { Coverage, Finding, Standard, StandardSnapshot, User, Verdict } from "../core/types.ts";
import type {
  ChatMessageView,
  DashboardView,
  ExceptionView,
  FindingView,
  Ref,
  ReviewDetail,
  ReviewSummary,
  SnapshotEntry,
  StandardChange,
  StandardHistoryView,
  StandardView,
} from "../core/api-types.ts";
import { isActive, type ActiveException } from "../core/exceptions.ts";

export type { ReviewDetail, ReviewSummary, SnapshotEntry, StandardChange, StandardView };

interface StandardRow {
  id: string;
  title: string;
  severity: Standard["severity"];
  detector: Standard["detector"];
  rule: string;
  compliant_example: string | null;
  violating_example: string | null;
  content_hash: string;
  enabled: number;
  updated_by: string | null;
  updated_by_name: string | null;
  updated_at: string;
  retired_at: string | null;
}


const toStandard = (r: StandardRow): StandardView => ({
  id: r.id,
  title: r.title,
  severity: r.severity,
  detector: r.detector,
  rule: r.rule,
  compliant: r.compliant_example ?? undefined,
  violating: r.violating_example ?? undefined,
  contentHash: r.content_hash,
  enabled: r.enabled === 1,
  updatedBy: r.updated_by ? { id: r.updated_by, name: r.updated_by_name ?? r.updated_by } : null,
  updatedAt: r.updated_at,
  retiredAt: r.retired_at,
});

/** What actually runs: a retired standard counts as disabled, whatever its stored flag says. */
export function effective(s: StandardView): StandardView {
  return s.retiredAt ? { ...s, enabled: false } : s;
}

const STANDARD_SELECT = `SELECT s.*, u.name AS updated_by_name FROM standards s LEFT JOIN users u ON u.id = s.updated_by`;

export async function getUser(db: D1Database, id: string): Promise<User | null> {
  return db.prepare("SELECT id, name, role FROM users WHERE id = ?").bind(id).first<User>();
}

export async function listUsers(db: D1Database): Promise<User[]> {
  return (await db.prepare("SELECT id, name, role FROM users ORDER BY role DESC, id").all<User>()).results;
}

export async function listStandards(db: D1Database): Promise<StandardView[]> {
  return (await db.prepare(`${STANDARD_SELECT} ORDER BY s.id`).all<StandardRow>()).results.map(toStandard);
}

export async function getStandard(db: D1Database, id: string): Promise<StandardView | null> {
  const r = await db.prepare(`${STANDARD_SELECT} WHERE s.id = ?`).bind(id).first<StandardRow>();
  return r ? toStandard(r) : null;
}

/**
 * Change `enabled` and append the audit row in one transaction, but only if the standard is
 * currently in the opposite state. The UPDATE is conditional on the old value, and the audit row
 * is inserted only if that UPDATE changed a row (`changes()` in the same transaction). So two
 * concurrent toggles in the same direction produce one change and one audit row, with the right
 * old value. Returns whether this call made the change.
 */
export async function setStandardEnabled(db: D1Database, id: string, enabled: boolean, by: string, at: string): Promise<boolean> {
  const [update] = await db.batch([
    db
      .prepare("UPDATE standards SET enabled = ?, updated_by = ?, updated_at = ? WHERE id = ? AND enabled = ? AND retired_at IS NULL")
      .bind(enabled ? 1 : 0, by, at, id, enabled ? 0 : 1),
    db
      .prepare(
        `INSERT INTO standard_changes (standard_id, field, old_value, new_value, changed_by, changed_at)
         SELECT ?, 'enabled', ?, ?, ?, ? WHERE changes() = 1`,
      )
      .bind(id, String(!enabled), String(enabled), by, at),
  ]);
  return (update?.meta.changes ?? 0) === 1;
}


export async function listStandardChanges(db: D1Database, standardId: string): Promise<StandardChange[]> {
  const rows = await db
    .prepare(
      `SELECT c.id, c.field, c.old_value, c.new_value, c.changed_by, u.name AS changed_by_name, c.changed_at
       FROM standard_changes c JOIN users u ON u.id = c.changed_by WHERE c.standard_id = ? ORDER BY c.changed_at DESC, c.id DESC`,
    )
    .bind(standardId)
    .all<{ id: number; field: string; old_value: string | null; new_value: string | null; changed_by: string; changed_by_name: string; changed_at: string }>();
  return rows.results.map((r) => ({
    id: r.id,
    field: r.field,
    oldValue: r.old_value,
    newValue: r.new_value,
    changedBy: { id: r.changed_by, name: r.changed_by_name },
    changedAt: r.changed_at,
  }));
}

// ---------------------------------------------------------------------------------------------
// Reviews

/** Stable finding id: the same review persisted twice yields the same ids (see INSERT OR IGNORE). */
export function findingId(reviewId: string, index: number): string {
  return `${reviewId}:${String(index).padStart(4, "0")}`;
}

export interface QueuedReview {
  id: string;
  authorId: string;
  inputKind: "snippet" | "diff";
  inputText: string;
  snapshot: StandardSnapshot[];
  engine: string;
  promptVersion: string | null;
  model: string | null;
  createdAt: string;
}

export async function insertQueuedReview(db: D1Database, r: QueuedReview): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reviews (id, author_id, input_kind, input_text, status, standards_snapshot, engine, prompt_version, model, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    )
    .bind(r.id, r.authorId, r.inputKind, r.inputText, JSON.stringify(r.snapshot), r.engine, r.promptVersion, r.model, r.createdAt)
    .run();
}

export async function markReviewRunning(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE reviews SET status = 'running' WHERE id = ? AND status = 'queued'").bind(id).run();
}

/** Never overwrites a completed review: a late failure report can't undo a persisted result. */
export async function markReviewFailed(db: D1Database, id: string, error: string, at: string): Promise<void> {
  await db
    .prepare("UPDATE reviews SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status IN ('queued', 'running')")
    .bind(error.slice(0, 1000), at, id)
    .run();
}

export type EventOutcome = "ok" | "retry" | "failed" | "skipped";

export async function addEvent(db: D1Database, reviewId: string, step: string, outcome: EventOutcome, durationMs: number | null, detail: string | null): Promise<void> {
  await db
    .prepare("INSERT INTO review_events (review_id, step, outcome, duration_ms, detail, at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(reviewId, step.slice(0, 256), outcome, durationMs, detail?.slice(0, 1000) ?? null, new Date().toISOString())
    .run();
}

/**
 * Findings, verdict and coverage in one transaction. Idempotent for Workflow retries: finding ids
 * are derived from (review id, index) and inserted with INSERT OR IGNORE, and the review row is
 * only updated while it isn't complete yet.
 */
export async function completeReview(
  db: D1Database,
  id: string,
  r: { verdict: Verdict; coverage: Coverage; findings: Finding[]; completedAt: string },
): Promise<void> {
  const stmts: D1PreparedStatement[] = r.findings.map((f, i) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO findings (id, review_id, standard_id, standard_hash, classification, severity, source, file, line_start, line_end, evidence, explanation, impact, remediation, pre_existing, waived_by_exception, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(findingId(id, i), id, f.standardId, f.standardHash, f.classification, f.severity, f.source, f.file, f.lineStart, f.lineEnd, f.evidence, f.explanation, f.impact, f.remediation, f.preExisting ? 1 : 0, f.waivedBy ?? null, r.completedAt),
  );
  stmts.push(
    db
      .prepare("UPDATE reviews SET status = 'complete', verdict = ?, coverage = ?, completed_at = ?, error = NULL WHERE id = ? AND status <> 'complete'")
      .bind(r.verdict, JSON.stringify(r.coverage), r.completedAt, id),
  );
  await db.batch(stmts);
}

/** What a Workflow run needs: the input, and every standard exactly as it was snapshotted at submit. */
export async function loadReviewForRun(db: D1Database, id: string): Promise<{ inputText: string; status: string; standards: Standard[] } | null> {
  const r = await db
    .prepare("SELECT input_text, status, standards_snapshot FROM reviews WHERE id = ?")
    .bind(id)
    .first<{ input_text: string; status: string; standards_snapshot: string }>();
  if (!r) return null;
  const snapshot = JSON.parse(r.standards_snapshot) as StandardSnapshot[];
  const versions = await db
    .prepare(
      `SELECT v.* FROM standard_versions v
       JOIN json_each(?) s ON v.standard_id = json_extract(s.value, '$.id') AND v.content_hash = json_extract(s.value, '$.contentHash')`,
    )
    .bind(r.standards_snapshot)
    .all<{
      standard_id: string; content_hash: string; title: string; severity: Standard["severity"]; detector: Standard["detector"];
      rule: string; compliant_example: string | null; violating_example: string | null;
    }>();
  const byKey = new Map(versions.results.map((v) => [`${v.standard_id}@${v.content_hash}`, v]));
  const standards: Standard[] = snapshot.map((s) => {
    const v = byKey.get(`${s.id}@${s.contentHash}`);
    if (!v) throw new Error(`Standard version ${s.id}@${s.contentHash} is missing from standard_versions.`);
    return {
      id: s.id,
      title: v.title,
      severity: v.severity,
      detector: v.detector,
      rule: v.rule,
      compliant: v.compliant_example ?? undefined,
      violating: v.violating_example ?? undefined,
      contentHash: s.contentHash,
      enabled: s.enabled,
    };
  });
  return { inputText: r.input_text, status: r.status, standards };
}

/** Whether a review is still queued/running although it was created before `before`. */
export async function isStale(db: D1Database, id: string, before: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS x FROM reviews WHERE id = ? AND status IN ('queued', 'running') AND created_at < ?").bind(id, before).first();
  return !!r;
}

// ---------------------------------------------------------------------------------------------
// Findings and challenges

export interface FindingForChallenge {
  id: string;
  reviewId: string;
  reviewAuthorId: string;
  standardId: string;
  standardTitle: string;
  standardRule: string;
  source: Finding["source"];
  file: string;
  lineStart: number;
  lineEnd: number;
  evidence: string;
  explanation: string;
  challengeOutcome: string | null;
  inputText: string;
}

export async function getFindingForChallenge(db: D1Database, id: string): Promise<FindingForChallenge | null> {
  const r = await db
    .prepare(
      `SELECT f.id, f.review_id, f.standard_id, v.title, v.rule, f.source, f.file, f.line_start, f.line_end, f.evidence, f.explanation,
              f.challenge_outcome, r.input_text, r.author_id
       FROM findings f
       JOIN reviews r ON r.id = f.review_id
       JOIN standard_versions v ON v.standard_id = f.standard_id AND v.content_hash = f.standard_hash
       WHERE f.id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!r) return null;
  return {
    id: r.id as string,
    reviewId: r.review_id as string,
    reviewAuthorId: r.author_id as string,
    standardId: r.standard_id as string,
    standardTitle: r.title as string,
    standardRule: r.rule as string,
    source: r.source as Finding["source"],
    file: r.file as string,
    lineStart: r.line_start as number,
    lineEnd: r.line_end as number,
    evidence: r.evidence as string,
    explanation: r.explanation as string,
    challengeOutcome: (r.challenge_outcome as string | null) ?? null,
    inputText: r.input_text as string,
  };
}

/**
 * Record a challenge: set the outcome (only if the finding hasn't been challenged yet) and append
 * the feedback row in the same transaction, only if that update happened. The finding's own fields
 * (classification, severity, evidence…) are never touched. Returns whether this call recorded it.
 */
export async function recordChallenge(
  db: D1Database,
  c: { findingId: string; userId: string; argument: string; outcome: "upheld" | "disputed"; assessment: { assessment: string; reasoning: string }; at: string },
): Promise<boolean> {
  const [update] = await db.batch([
    db.prepare("UPDATE findings SET challenge_outcome = ? WHERE id = ? AND challenge_outcome IS NULL").bind(c.outcome, c.findingId),
    db
      .prepare(
        `INSERT INTO feedback (finding_id, user_id, action, reason, llm_assessment, created_at)
         SELECT ?, ?, 'challenge', ?, ?, ? WHERE changes() = 1`,
      )
      .bind(c.findingId, c.userId, c.argument, JSON.stringify(c.assessment), c.at),
  ]);
  return (update?.meta.changes ?? 0) === 1;
}

export async function listReviews(db: D1Database, limit: number): Promise<ReviewSummary[]> {
  const rows = await db
    .prepare(
      `SELECT r.id, r.author_id, u.name AS author_name, r.input_kind, r.status, r.verdict, r.created_at,
              (SELECT COUNT(*) FROM findings f WHERE f.review_id = r.id) AS finding_count
       FROM reviews r JOIN users u ON u.id = r.author_id ORDER BY r.created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: string; author_id: string; author_name: string; input_kind: string; status: string; verdict: Verdict | null; created_at: string; finding_count: number }>();
  return rows.results.map((r) => ({
    id: r.id,
    author: { id: r.author_id, name: r.author_name },
    inputKind: r.input_kind,
    status: r.status,
    verdict: r.verdict,
    findingCount: r.finding_count,
    createdAt: r.created_at,
  }));
}



export async function getReview(db: D1Database, id: string): Promise<Omit<ReviewDetail, "viewerCanChallenge" | "viewerCanGiveFeedback"> | null> {
  const r = await db
    .prepare(`SELECT r.*, u.name AS author_name FROM reviews r JOIN users u ON u.id = r.author_id WHERE r.id = ?`)
    .bind(id)
    .first<{
      id: string; author_id: string; author_name: string; input_kind: string; input_text: string; status: string; verdict: Verdict | null;
      coverage: string | null; standards_snapshot: string; engine: string; prompt_version: string | null; model: string | null;
      created_at: string; completed_at: string | null; error: string | null;
    }>();
  if (!r) return null;

  // Only the versions this review ran against: the snapshot's (id, hash) pairs, passed as one JSON
  // parameter (no per-standard placeholders, so no bound-parameter limit as standards grow).
  const [versions, current, findings, events, challenges, messages] = await db.batch([
    db
      .prepare(
        `SELECT v.standard_id, v.content_hash, v.title, v.rule FROM standard_versions v
         JOIN json_each(?) s ON v.standard_id = json_extract(s.value, '$.id') AND v.content_hash = json_extract(s.value, '$.contentHash')`,
      )
      .bind(r.standards_snapshot),
    db.prepare("SELECT id, content_hash, enabled, retired_at FROM standards"),
    db
      .prepare(
        `SELECT f.*, w.path_pattern AS w_pattern, w.expires_at AS w_expires, w.decided_by AS w_by, wu.name AS w_by_name,
                (SELECT x.id FROM exceptions x WHERE x.source_finding = f.id ORDER BY x.created_at DESC, x.id LIMIT 1) AS req_id,
                (SELECT x.status FROM exceptions x WHERE x.source_finding = f.id ORDER BY x.created_at DESC, x.id LIMIT 1) AS req_status
         FROM findings f
         LEFT JOIN exceptions w ON w.id = f.waived_by_exception
         LEFT JOIN users wu ON wu.id = w.decided_by
         WHERE f.review_id = ? ORDER BY f.file, f.line_start, f.standard_id, f.id`,
      )
      .bind(id),
    db.prepare("SELECT step, outcome, duration_ms, detail, at FROM review_events WHERE review_id = ? ORDER BY id").bind(id),
    db
      .prepare(
        `SELECT fb.finding_id, fb.reason, fb.llm_assessment, fb.created_at, u.id AS user_id, u.name AS user_name
         FROM feedback fb JOIN users u ON u.id = fb.user_id
         WHERE fb.action = 'challenge' AND fb.finding_id IN (SELECT id FROM findings WHERE review_id = ?)`,
      )
      .bind(id),
    chatSelect(db, id),
  ]);
  const challengeOf = new Map(
    (challenges!.results as { finding_id: string; reason: string; llm_assessment: string | null; created_at: string; user_id: string; user_name: string }[]).map((c) => {
      const a = c.llm_assessment ? (JSON.parse(c.llm_assessment) as { assessment: string; reasoning: string }) : null;
      return [c.finding_id, { by: { id: c.user_id, name: c.user_name }, argument: c.reason, assessment: a?.assessment ?? null, reasoning: a?.reasoning ?? null, at: c.created_at }];
    }),
  );

  const versionOf = new Map((versions!.results as { standard_id: string; content_hash: string; title: string; rule: string }[]).map((v) => [`${v.standard_id}@${v.content_hash}`, v]));
  const now = new Map((current!.results as { id: string; content_hash: string; enabled: number; retired_at: string | null }[]).map((s) => [s.id, s]));
  const snapshot = JSON.parse(r.standards_snapshot) as StandardSnapshot[];

  return {
    id: r.id,
    author: { id: r.author_id, name: r.author_name },
    inputKind: r.input_kind,
    inputText: r.input_text,
    status: r.status,
    verdict: r.verdict,
    coverage: r.coverage ? (JSON.parse(r.coverage) as Coverage) : null,
    engine: r.engine,
    promptVersion: r.prompt_version,
    model: r.model,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    error: r.error,
    standards: snapshot.map((s) => {
      const v = versionOf.get(`${s.id}@${s.contentHash}`);
      const c = now.get(s.id);
      return {
        ...s,
        title: v?.title ?? null,
        rule: v?.rule ?? null,
        changedSince: {
          content: !!c && c.content_hash !== s.contentHash,
          enabled: !!c && (c.enabled === 1 && c.retired_at === null) !== s.enabled,
        },
      };
    }),
    findings: (findings!.results as Record<string, unknown>[]).map((f) => ({
      id: f.id as string,
      standardId: f.standard_id as string,
      standardHash: f.standard_hash as string,
      standardTitle: versionOf.get(`${f.standard_id}@${f.standard_hash}`)?.title ?? null,
      classification: f.classification as Finding["classification"],
      severity: f.severity as Finding["severity"],
      source: f.source as Finding["source"],
      file: f.file as string,
      lineStart: f.line_start as number,
      lineEnd: f.line_end as number,
      evidence: f.evidence as string,
      explanation: f.explanation as string,
      impact: f.impact as string,
      remediation: f.remediation as string,
      preExisting: f.pre_existing === 1,
      challengeOutcome: (f.challenge_outcome as FindingView["challengeOutcome"]) ?? null,
      challenge: challengeOf.get(f.id as string) ?? null,
      disposition: f.disposition as FindingView["disposition"],
      waivedBy: (f.waived_by_exception as string | null) ?? null,
      waiver: f.waived_by_exception
        ? {
            id: f.waived_by_exception as string,
            pathPattern: f.w_pattern as string,
            decidedBy: f.w_by ? { id: f.w_by as string, name: (f.w_by_name as string) ?? (f.w_by as string) } : null,
            expiresAt: f.w_expires as string,
          }
        : null,
      exceptionRequest: f.req_id ? { id: f.req_id as string, status: f.req_status as ExceptionView["status"] } : null,
    })),
    history: await standardHistory(db, id),
    messages: (messages!.results as ChatRow[]).map(toChatMessage),
    events: (events!.results as { step: string; outcome: string; duration_ms: number | null; detail: string | null; at: string }[]).map((e) => ({
      step: e.step,
      outcome: e.outcome,
      durationMs: e.duration_ms,
      detail: e.detail,
      at: e.at,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Feedback (accept / reject)

/**
 * Set the latest disposition and append the feedback row in one transaction. The finding's own
 * fields and the review's verdict are never touched: feedback is a signal, not a waiver.
 */
export async function recordFeedback(
  db: D1Database,
  f: { findingId: string; userId: string; action: "accept" | "reject"; reason: string | null; at: string },
): Promise<void> {
  await db.batch([
    db.prepare("UPDATE findings SET disposition = ? WHERE id = ?").bind(f.action === "accept" ? "accepted" : "rejected", f.findingId),
    db.prepare("INSERT INTO feedback (finding_id, user_id, action, reason, created_at) VALUES (?, ?, ?, ?, ?)").bind(f.findingId, f.userId, f.action, f.reason, f.at),
  ]);
}

/**
 * How each standard with findings in this review fared in OTHER reviews: counts of accepted,
 * rejected and disputed findings, and the three latest rejection reasons. For people (the panel
 * next to a finding, chat, the dashboard) only; detection never reads it (design §6).
 */
export async function standardHistory(db: D1Database, reviewId: string): Promise<StandardHistoryView[]> {
  const [counts, reasons] = await db.batch([
    db
      .prepare(
        `SELECT f.standard_id,
                COALESCE(SUM(f.disposition = 'accepted'), 0) AS accepted,
                COALESCE(SUM(f.disposition = 'rejected'), 0) AS rejected,
                COALESCE(SUM(f.challenge_outcome = 'disputed'), 0) AS disputed
         FROM findings f
         WHERE f.review_id <> ?1 AND f.standard_id IN (SELECT standard_id FROM findings WHERE review_id = ?1)
         GROUP BY f.standard_id`,
      )
      .bind(reviewId),
    db
      .prepare(
        `SELECT standard_id, reason, user_id, user_name, created_at FROM (
           SELECT f.standard_id, fb.reason, fb.user_id, u.name AS user_name, fb.created_at,
                  ROW_NUMBER() OVER (PARTITION BY f.standard_id ORDER BY fb.created_at DESC, fb.id DESC) AS rn
           FROM feedback fb JOIN findings f ON f.id = fb.finding_id JOIN users u ON u.id = fb.user_id
           WHERE fb.action = 'reject' AND f.review_id <> ?1 AND f.standard_id IN (SELECT standard_id FROM findings WHERE review_id = ?1)
         ) WHERE rn <= 3 ORDER BY standard_id, created_at DESC`,
      )
      .bind(reviewId),
  ]);
  const byStd = new Map<string, StandardHistoryView>();
  for (const c of counts!.results as { standard_id: string; accepted: number; rejected: number; disputed: number }[]) {
    byStd.set(c.standard_id, { standardId: c.standard_id, accepted: c.accepted, rejected: c.rejected, disputed: c.disputed, recentReasons: [] });
  }
  for (const r of reasons!.results as { standard_id: string; reason: string; user_id: string; user_name: string; created_at: string }[]) {
    byStd.get(r.standard_id)?.recentReasons.push({ reason: r.reason, by: { id: r.user_id, name: r.user_name }, at: r.created_at });
  }
  return [...byStd.values()].sort((a, b) => a.standardId.localeCompare(b.standardId));
}

// ---------------------------------------------------------------------------------------------
// Exceptions

interface ExceptionRow {
  id: string;
  standard_id: string;
  standard_title: string | null;
  path_pattern: string;
  justification: string;
  source_finding: string | null;
  sf_review: string | null;
  sf_file: string | null;
  sf_line: number | null;
  requested_by: string;
  requested_by_name: string;
  status: ExceptionView["status"];
  decided_by: string | null;
  decided_by_name: string | null;
  decision_note: string | null;
  expires_at: string;
  created_at: string;
  decided_at: string | null;
}

const EXCEPTION_SELECT = `
  SELECT e.*, s.title AS standard_title, rq.name AS requested_by_name, dc.name AS decided_by_name,
         sf.review_id AS sf_review, sf.file AS sf_file, sf.line_start AS sf_line
  FROM exceptions e
  JOIN users rq ON rq.id = e.requested_by
  LEFT JOIN users dc ON dc.id = e.decided_by
  LEFT JOIN standards s ON s.id = e.standard_id
  LEFT JOIN findings sf ON sf.id = e.source_finding`;

function toException(r: ExceptionRow, now: Date): ExceptionView {
  const state = r.status === "approved" ? (isActive({ status: r.status, expiresAt: r.expires_at }, now) ? "active" : "expired") : r.status;
  return {
    id: r.id,
    standardId: r.standard_id,
    standardTitle: r.standard_title,
    pathPattern: r.path_pattern,
    justification: r.justification,
    sourceFinding: r.source_finding ? { id: r.source_finding, reviewId: r.sf_review!, file: r.sf_file!, lineStart: r.sf_line! } : null,
    requestedBy: { id: r.requested_by, name: r.requested_by_name },
    status: r.status,
    state,
    decidedBy: r.decided_by ? { id: r.decided_by, name: r.decided_by_name ?? r.decided_by } : null,
    decisionNote: r.decision_note,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

export async function insertException(
  db: D1Database,
  e: { id: string; standardId: string; pathPattern: string; justification: string; sourceFinding: string | null; requestedBy: string; expiresAt: string; createdAt: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO exceptions (id, standard_id, path_pattern, justification, source_finding, requested_by, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(e.id, e.standardId, e.pathPattern, e.justification, e.sourceFinding, e.requestedBy, e.expiresAt, e.createdAt)
    .run();
}

export async function getException(db: D1Database, id: string, now: Date): Promise<ExceptionView | null> {
  const r = await db.prepare(`${EXCEPTION_SELECT} WHERE e.id = ?`).bind(id).first<ExceptionRow>();
  return r ? toException(r, now) : null;
}

export async function hasPendingExceptionFor(db: D1Database, findingId: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS x FROM exceptions WHERE source_finding = ? AND status = 'pending'").bind(findingId).first());
}

/** `state` filters on the derived state; active and expired are computed against `now`. */
export async function listExceptions(db: D1Database, state: ExceptionView["state"] | null, now: Date, limit = 100): Promise<ExceptionView[]> {
  const where = {
    pending: "e.status = 'pending'",
    denied: "e.status = 'denied'",
    active: "e.status = 'approved' AND e.expires_at > ?1",
    expired: "e.status = 'approved' AND e.expires_at <= ?1",
  } as const;
  const sql = `${EXCEPTION_SELECT} WHERE ${state ? where[state] : "?1 = ?1"} ORDER BY e.created_at DESC, e.id LIMIT ?2`;
  return (await db.prepare(sql).bind(now.toISOString(), limit).all<ExceptionRow>()).results.map((r) => toException(r, now));
}

/** Active exceptions for the review pipeline's waiver step (design §5, load-context). */
export async function listActiveExceptions(db: D1Database, now: Date): Promise<ActiveException[]> {
  const rows = await db
    .prepare("SELECT id, standard_id, path_pattern FROM exceptions WHERE status = 'approved' AND expires_at > ? ORDER BY decided_at, id")
    .bind(now.toISOString())
    .all<{ id: string; standard_id: string; path_pattern: string }>();
  return rows.results.map((r) => ({ id: r.id, standardId: r.standard_id, pathPattern: r.path_pattern }));
}

/** Findings of one review, for deciding which ones an approved exception waives. */
export async function findingsForWaiver(db: D1Database, reviewId: string): Promise<{ id: string; standardId: string; file: string; waivedBy: string | null }[]> {
  const rows = await db
    .prepare("SELECT id, standard_id, file, waived_by_exception FROM findings WHERE review_id = ?")
    .bind(reviewId)
    .all<{ id: string; standard_id: string; file: string; waived_by_exception: string | null }>();
  return rows.results.map((r) => ({ id: r.id, standardId: r.standard_id, file: r.file, waivedBy: r.waived_by_exception }));
}

/**
 * The verdict recomputed in SQL from the stored findings, so approving an exception updates it
 * atomically even when two exceptions for one review are approved at once. Mirrors
 * core/verdict.ts computeVerdict: waived findings don't count; coverage gaps make it incomplete.
 */
const RECOMPUTED_VERDICT = `CASE
  WHEN EXISTS (SELECT 1 FROM findings v WHERE v.review_id = reviews.id AND v.classification = 'violation' AND v.waived_by_exception IS NULL AND v.severity = 'blocker') THEN 'fail'
  WHEN json_array_length(reviews.coverage, '$.skipped') > 0 THEN 'incomplete'
  WHEN EXISTS (SELECT 1 FROM findings v WHERE v.review_id = reviews.id AND v.classification = 'violation' AND v.waived_by_exception IS NULL) THEN 'warn'
  ELSE 'pass' END`;

/**
 * Decide a pending exception in one transaction. The status update is conditional on it still being
 * pending (and, for an approval, unexpired), so a concurrent decision can't overwrite this one.
 * Every later statement checks that THIS call made the decision (same decider and timestamp), so
 * if it lost the race nothing else is written.
 *
 * An approval also waives the matching findings of the review the request came from
 * (`waive.findingIds`), recomputes that review's verdict and records a review event (prompt 10).
 * Returns whether this call made the decision.
 */
export async function decideException(
  db: D1Database,
  d: {
    id: string;
    decision: "approved" | "denied";
    by: Ref;
    note: string | null;
    at: string;
    waive: { reviewId: string; findingIds: string[] } | null;
  },
): Promise<boolean> {
  const madeHere = "EXISTS (SELECT 1 FROM exceptions WHERE id = ?1 AND status = 'approved' AND decided_by = ?2 AND decided_at = ?3)";
  const stmts: D1PreparedStatement[] = [
    db
      .prepare("UPDATE exceptions SET status = ?2, decided_by = ?3, decided_at = ?4, decision_note = ?5 WHERE id = ?1 AND status = 'pending' AND (?2 = 'denied' OR expires_at > ?4)")
      .bind(d.id, d.decision, d.by.id, d.at, d.note),
  ];
  if (d.decision === "approved" && d.waive) {
    const { reviewId, findingIds } = d.waive;
    stmts.push(
      db
        .prepare(`UPDATE findings SET waived_by_exception = ?1 WHERE review_id = ?4 AND waived_by_exception IS NULL AND id IN (SELECT value FROM json_each(?5)) AND ${madeHere}`)
        .bind(d.id, d.by.id, d.at, reviewId, JSON.stringify(findingIds)),
      db.prepare(`UPDATE reviews SET verdict = ${RECOMPUTED_VERDICT} WHERE id = ?4 AND status = 'complete' AND ${madeHere}`).bind(d.id, d.by.id, d.at, reviewId),
      db
        .prepare(
          `INSERT INTO review_events (review_id, step, outcome, duration_ms, detail, at)
           SELECT id, 'exception', 'ok', NULL,
                  'Exception ' || ?1 || ' approved by ' || ?5 || ': ' ||
                  (SELECT COUNT(*) FROM findings WHERE review_id = ?4 AND waived_by_exception = ?1) || ' finding(s) waived; verdict now ' || verdict,
                  ?3
           FROM reviews WHERE id = ?4 AND status = 'complete' AND ${madeHere}`,
        )
        .bind(d.id, d.by.id, d.at, reviewId, d.by.name),
    );
  }
  const [update] = await db.batch(stmts);
  return (update?.meta.changes ?? 0) === 1;
}

// ---------------------------------------------------------------------------------------------
// Chat

interface ChatRow {
  id: number;
  role: "user" | "assistant";
  user_id: string | null;
  user_name: string | null;
  content: string;
  created_at: string;
}

const MAX_CHAT_SHOWN = 50;

function chatSelect(db: D1Database, reviewId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT m.id, m.role, m.user_id, u.name AS user_name, m.content, m.created_at
         FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.review_id = ? ORDER BY m.id DESC LIMIT ?
       ) ORDER BY id`,
    )
    .bind(reviewId, MAX_CHAT_SHOWN);
}

const toChatMessage = (r: ChatRow): ChatMessageView => ({
  id: r.id,
  role: r.role,
  user: r.user_id ? { id: r.user_id, name: r.user_name ?? r.user_id } : null,
  content: r.content,
  createdAt: r.created_at,
});

export async function listChat(db: D1Database, reviewId: string): Promise<ChatMessageView[]> {
  return (await chatSelect(db, reviewId).all<ChatRow>()).results.map(toChatMessage);
}

/** The question and the answer are stored together, only after the model answered. */
export async function appendChat(db: D1Database, c: { reviewId: string; userId: string; question: string; reply: string; at: string }): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO chat_messages (review_id, user_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)").bind(c.reviewId, c.userId, c.question, c.at),
    db.prepare("INSERT INTO chat_messages (review_id, user_id, role, content, created_at) VALUES (?, NULL, 'assistant', ?, ?)").bind(c.reviewId, c.reply, c.at),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Dashboard (design §7)

export async function dashboard(db: D1Database, now: Date): Promise<Omit<DashboardView, "budget">> {
  const [total, verdicts, f, top, rates, ex] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM reviews"),
    db.prepare("SELECT verdict, COUNT(*) AS n FROM reviews WHERE status = 'complete' GROUP BY verdict"),
    db.prepare(
      `SELECT
         COALESCE(SUM(classification = 'violation' AND waived_by_exception IS NULL AND severity = 'blocker'), 0) AS blocker,
         COALESCE(SUM(classification = 'violation' AND waived_by_exception IS NULL AND severity = 'major'), 0) AS major,
         COALESCE(SUM(classification = 'violation' AND waived_by_exception IS NULL AND severity = 'minor'), 0) AS minor,
         COALESCE(SUM(classification = 'suggestion'), 0) AS suggestions,
         COALESCE(SUM(waived_by_exception IS NOT NULL), 0) AS waived,
         COALESCE(SUM(disposition = 'open'), 0) AS open,
         COALESCE(SUM(disposition = 'accepted'), 0) AS accepted,
         COALESCE(SUM(disposition = 'rejected'), 0) AS rejected,
         COALESCE(SUM(challenge_outcome = 'upheld'), 0) AS upheld,
         COALESCE(SUM(challenge_outcome = 'disputed'), 0) AS disputed
       FROM findings`,
    ),
    db.prepare(
      `SELECT f.standard_id AS id, s.title, COUNT(*) AS count FROM findings f LEFT JOIN standards s ON s.id = f.standard_id
       GROUP BY f.standard_id ORDER BY count DESC, f.standard_id LIMIT 5`,
    ),
    db.prepare(
      `SELECT standard_id AS id, SUM(disposition = 'rejected') AS rejected, SUM(disposition IN ('accepted', 'rejected')) AS n
       FROM findings GROUP BY standard_id HAVING n > 0 ORDER BY standard_id`,
    ),
    db
      .prepare(
        `SELECT COALESCE(SUM(status = 'pending'), 0) AS pending,
                COALESCE(SUM(status = 'approved' AND expires_at > ?1), 0) AS active,
                COALESCE(SUM(status = 'approved' AND expires_at <= ?1), 0) AS expired,
                COALESCE(SUM(status = 'denied'), 0) AS denied
         FROM exceptions`,
      )
      .bind(now.toISOString()),
  ]);
  const v: Record<string, number> = { pass: 0, warn: 0, fail: 0, incomplete: 0 };
  for (const r of verdicts!.results as { verdict: string; n: number }[]) if (r.verdict in v) v[r.verdict] = r.n;
  const s = f!.results[0] as Record<string, number>;
  const e = ex!.results[0] as Record<string, number>;
  return {
    totalReviews: (total!.results[0] as { n: number }).n,
    verdicts: v as DashboardView["verdicts"],
    violationsBySeverity: { blocker: s.blocker!, major: s.major!, minor: s.minor! },
    suggestions: s.suggestions!,
    waived: s.waived!,
    topStandards: top!.results as DashboardView["topStandards"],
    dispositions: { open: s.open!, accepted: s.accepted!, rejected: s.rejected! },
    rejectRateByStandard: (rates!.results as { id: string; rejected: number; n: number }[]).map((r) => ({ id: r.id, rate: r.rejected / r.n, n: r.n })),
    challenges: { upheld: s.upheld!, disputed: s.disputed! },
    exceptions: { pending: e.pending!, active: e.active!, expired: e.expired!, denied: e.denied! },
  };
}
