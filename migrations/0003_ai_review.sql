-- PR 3-B: AI review through a Workflow, challenges, and the daily AI budget.

-- An AI finding whose evidence is only on unchanged lines of a diff: shown as a "pre-existing"
-- suggestion (design §6).
ALTER TABLE findings ADD COLUMN pre_existing INTEGER NOT NULL DEFAULT 0 CHECK (pre_existing IN (0, 1));

-- Outcome of a challenge. Set at most once. It never changes the finding's classification, severity
-- or the review's verdict (prompt 3).
ALTER TABLE findings ADD COLUMN challenge_outcome TEXT CHECK (challenge_outcome IN ('upheld', 'disputed'));

-- Every action on a finding, append-only. PR 3-B writes challenges; 3-C adds accept and reject.
CREATE TABLE feedback (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id     TEXT NOT NULL REFERENCES findings(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  action         TEXT NOT NULL CHECK (action IN ('accept', 'reject', 'challenge')),
  reason         TEXT,              -- required for reject and challenge
  llm_assessment TEXT,              -- challenge only: JSON {assessment, reasoning}
  created_at     TEXT NOT NULL,
  CHECK (action = 'accept' OR (reason IS NOT NULL AND length(reason) > 0))
);
CREATE INDEX idx_feedback_finding ON feedback(finding_id);

-- Strict daily cap on model calls, one counter per UTC day and bucket (design §10).
CREATE TABLE llm_budget (
  day    TEXT NOT NULL,             -- 'YYYY-MM-DD' (UTC)
  bucket TEXT NOT NULL CHECK (bucket IN ('app', 'eval')),
  used   INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (day, bucket)
);

CREATE INDEX idx_reviews_status ON reviews(status, created_at);
