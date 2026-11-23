// D1 access. All SQL lives here, always with bound parameters.
import type { Coverage, Finding, Standard, StandardSnapshot, User, Verdict } from "../core/types.ts";
import type { ReviewDetail, ReviewSummary, SnapshotEntry, StandardChange, StandardView } from "../core/api-types.ts";

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
});

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

/** Change `enabled` and append the audit row in one transaction. */
export async function setStandardEnabled(db: D1Database, id: string, enabled: boolean, by: string, at: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE standards SET enabled = ?, updated_by = ?, updated_at = ? WHERE id = ?").bind(enabled ? 1 : 0, by, at, id),
    db
      .prepare("INSERT INTO standard_changes (standard_id, field, old_value, new_value, changed_by, changed_at) VALUES (?, 'enabled', ?, ?, ?, ?)")
      .bind(id, String(!enabled), String(enabled), by, at),
  ]);
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

export interface NewReview {
  id: string;
  authorId: string;
  inputKind: "snippet" | "diff";
  inputText: string;
  verdict: Verdict;
  coverage: Coverage;
  snapshot: StandardSnapshot[];
  engine: string;
  createdAt: string;
  completedAt: string;
  findings: Finding[];
  events: { step: string; outcome: "ok" | "retry" | "failed" | "skipped"; durationMs: number; detail?: string }[];
}

/** Review, findings and events in one transaction: a review is never visible half-written. */
export async function insertCompletedReview(db: D1Database, r: NewReview): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO reviews (id, author_id, input_kind, input_text, status, verdict, coverage, standards_snapshot, engine, created_at, completed_at)
         VALUES (?, ?, ?, ?, 'complete', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(r.id, r.authorId, r.inputKind, r.inputText, r.verdict, JSON.stringify(r.coverage), JSON.stringify(r.snapshot), r.engine, r.createdAt, r.completedAt),
  ];
  for (const f of r.findings) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO findings (id, review_id, standard_id, standard_hash, classification, severity, source, file, line_start, line_end, evidence, explanation, impact, remediation, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), r.id, f.standardId, f.standardHash, f.classification, f.severity, f.source, f.file, f.lineStart, f.lineEnd, f.evidence, f.explanation, f.impact, f.remediation, r.createdAt),
    );
  }
  for (const e of r.events) {
    stmts.push(
      db
        .prepare("INSERT INTO review_events (review_id, step, outcome, duration_ms, detail, at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(r.id, e.step, e.outcome, e.durationMs, e.detail ?? null, r.completedAt),
    );
  }
  await db.batch(stmts);
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
      coverage: string | null; standards_snapshot: string; engine: string; created_at: string; completed_at: string | null; error: string | null;
    }>();
  if (!r) return null;

  const [versions, current, findings, events] = await db.batch([
    db.prepare("SELECT standard_id, content_hash, title, rule FROM standard_versions"),
    db.prepare("SELECT id, content_hash, enabled FROM standards"),
    db.prepare("SELECT * FROM findings WHERE review_id = ? ORDER BY file, line_start, standard_id").bind(id),
    db.prepare("SELECT step, outcome, duration_ms, detail, at FROM review_events WHERE review_id = ? ORDER BY id").bind(id),
  ]);

  const versionOf = new Map((versions!.results as { standard_id: string; content_hash: string; title: string; rule: string }[]).map((v) => [`${v.standard_id}@${v.content_hash}`, v]));
  const now = new Map((current!.results as { id: string; content_hash: string; enabled: number }[]).map((s) => [s.id, s]));
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
        changedSince: { content: !!c && c.content_hash !== s.contentHash, enabled: !!c && (c.enabled === 1) !== s.enabled },
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
