// D1 access. All SQL lives here, always with bound parameters.
import type { Coverage, Finding, Standard, StandardSnapshot, User, Verdict } from "../core/types.ts";
import type { FindingView, ReviewDetail, ReviewSummary, SnapshotEntry, StandardChange, StandardView } from "../core/api-types.ts";

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
        `INSERT OR IGNORE INTO findings (id, review_id, standard_id, standard_hash, classification, severity, source, file, line_start, line_end, evidence, explanation, impact, remediation, pre_existing, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(findingId(id, i), id, f.standardId, f.standardHash, f.classification, f.severity, f.source, f.file, f.lineStart, f.lineEnd, f.evidence, f.explanation, f.impact, f.remediation, f.preExisting ? 1 : 0, r.completedAt),
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
              f.challenge_outcome, r.input_text
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



export async function getReview(db: D1Database, id: string): Promise<ReviewDetail | null> {
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
  const [versions, current, findings, events, challenges] = await db.batch([
    db
      .prepare(
        `SELECT v.standard_id, v.content_hash, v.title, v.rule FROM standard_versions v
         JOIN json_each(?) s ON v.standard_id = json_extract(s.value, '$.id') AND v.content_hash = json_extract(s.value, '$.contentHash')`,
      )
      .bind(r.standards_snapshot),
    db.prepare("SELECT id, content_hash, enabled, retired_at FROM standards"),
    db.prepare("SELECT * FROM findings WHERE review_id = ? ORDER BY file, line_start, standard_id").bind(id),
    db.prepare("SELECT step, outcome, duration_ms, detail, at FROM review_events WHERE review_id = ? ORDER BY id").bind(id),
    db
      .prepare(
        `SELECT fb.finding_id, fb.reason, fb.llm_assessment, fb.created_at, u.id AS user_id, u.name AS user_name
         FROM feedback fb JOIN users u ON u.id = fb.user_id
         WHERE fb.action = 'challenge' AND fb.finding_id IN (SELECT id FROM findings WHERE review_id = ?)`,
      )
      .bind(id),
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
    })),
    events: (events!.results as { step: string; outcome: string; duration_ms: number | null; detail: string | null; at: string }[]).map((e) => ({
      step: e.step,
      outcome: e.outcome,
      durationMs: e.duration_ms,
      detail: e.detail,
      at: e.at,
    })),
  };
}
