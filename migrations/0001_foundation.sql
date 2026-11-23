-- PR 3-A: identity, standards (with versions and an audit log), and rules-only reviews.
-- Later PRs add their own migrations (workflow status fields, feedback, exceptions, chat).

CREATE TABLE users (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('developer', 'approver'))
);

-- Current state of each standard. Content comes from standards/*.yaml via the seed script;
-- `enabled` is owned by the app and survives re-seeding.
CREATE TABLE standards (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  severity          TEXT NOT NULL CHECK (severity IN ('blocker', 'major', 'minor')),
  detector          TEXT NOT NULL CHECK (detector IN ('rule', 'llm', 'rule+llm')),
  rule              TEXT NOT NULL,
  compliant_example TEXT,
  violating_example TEXT,
  content_hash      TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_by        TEXT REFERENCES users(id),   -- last person to enable/disable it
  updated_at        TEXT NOT NULL
);

-- Every content version ever seeded. Reviews point at (standard_id, content_hash), so an old
-- review can still show the exact rule text it was checked against after the YAML changes.
CREATE TABLE standard_versions (
  standard_id   TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  title         TEXT NOT NULL,
  severity      TEXT NOT NULL,
  detector      TEXT NOT NULL,
  rule          TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (standard_id, content_hash)
);

-- Append-only audit log of enable/disable changes: who and when.
CREATE TABLE standard_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  standard_id TEXT NOT NULL REFERENCES standards(id),
  field       TEXT NOT NULL CHECK (field IN ('enabled')),
  old_value   TEXT,
  new_value   TEXT,
  changed_by  TEXT NOT NULL REFERENCES users(id),
  changed_at  TEXT NOT NULL
);
CREATE INDEX idx_standard_changes_standard ON standard_changes(standard_id, changed_at);

CREATE TABLE reviews (
  id                 TEXT PRIMARY KEY,
  author_id          TEXT NOT NULL REFERENCES users(id),
  input_kind         TEXT NOT NULL CHECK (input_kind IN ('snippet', 'diff')),
  input_text         TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  verdict            TEXT CHECK (verdict IN ('pass', 'warn', 'fail', 'incomplete')),
  coverage           TEXT,            -- JSON Coverage
  standards_snapshot TEXT NOT NULL,   -- JSON StandardSnapshot[] for ALL standards at submit time
  engine             TEXT NOT NULL,   -- which detectors ran, e.g. 'rules'
  prompt_version     TEXT,            -- NULL until the LLM detector exists (PR 3-B)
  model              TEXT,
  error              TEXT,
  created_at         TEXT NOT NULL,
  completed_at       TEXT
);
CREATE INDEX idx_reviews_created ON reviews(created_at);

-- One row per pipeline step outcome, for observability in the UI.
CREATE TABLE review_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id   TEXT NOT NULL REFERENCES reviews(id),
  step        TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok', 'retry', 'failed', 'skipped')),
  duration_ms INTEGER,
  detail      TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX idx_review_events_review ON review_events(review_id);

-- Findings are written once and never edited; later PRs add disposition/challenge/waiver columns
-- that record what happened to a finding without changing the finding itself.
CREATE TABLE findings (
  id             TEXT PRIMARY KEY,
  review_id      TEXT NOT NULL REFERENCES reviews(id),
  standard_id    TEXT NOT NULL REFERENCES standards(id),
  standard_hash  TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('violation', 'suggestion')),
  severity       TEXT NOT NULL CHECK (severity IN ('blocker', 'major', 'minor')),
  source         TEXT NOT NULL CHECK (source IN ('rule', 'llm')),
  file           TEXT NOT NULL,
  line_start     INTEGER NOT NULL,
  line_end       INTEGER NOT NULL,
  evidence       TEXT NOT NULL,
  explanation    TEXT NOT NULL,
  impact         TEXT NOT NULL,
  remediation    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_findings_review ON findings(review_id);
CREATE INDEX idx_findings_standard_file ON findings(standard_id, file);
