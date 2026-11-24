-- PR 3-C: exceptions, accept/reject feedback and chat.

-- Exceptions: the only thing that can waive a violation (prompt 3). A request is pending until an
-- approver other than the requester decides it. "Active" and "expired" aren't stored: an exception
-- is active only while status = 'approved' AND expires_at > now, so it can't be left stale.
CREATE TABLE exceptions (
  id             TEXT PRIMARY KEY,
  standard_id    TEXT NOT NULL REFERENCES standards(id),
  path_pattern   TEXT NOT NULL,        -- glob, e.g. 'scripts/**'; '*' means every path
  justification  TEXT NOT NULL CHECK (length(justification) > 0),
  source_finding TEXT REFERENCES findings(id),
  requested_by   TEXT NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  decided_by     TEXT REFERENCES users(id),
  decision_note  TEXT,
  expires_at     TEXT NOT NULL,        -- required; at most 90 days after the request (checked by the API)
  created_at     TEXT NOT NULL,
  decided_at     TEXT,
  CHECK (decided_by IS NULL OR decided_by <> requested_by),  -- no self-approval, even if app code is bypassed
  CHECK ((status = 'pending') = (decided_by IS NULL)),       -- decided exactly when it has a decider
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX idx_exceptions_standard_status ON exceptions(standard_id, status);
CREATE INDEX idx_exceptions_source ON exceptions(source_finding);

-- What happened to a finding, without changing the finding itself. A waiver is set at most once:
-- by the review's apply-exceptions step, or when an exception requested from the finding is approved.
ALTER TABLE findings ADD COLUMN waived_by_exception TEXT REFERENCES exceptions(id);
-- Latest accept/reject; the full history is in feedback. Never an input to detection or the verdict.
ALTER TABLE findings ADD COLUMN disposition TEXT NOT NULL DEFAULT 'open' CHECK (disposition IN ('open', 'accepted', 'rejected'));

-- Advisory chat about one review. Assistant messages have no user.
CREATE TABLE chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id  TEXT NOT NULL REFERENCES reviews(id),
  user_id    TEXT REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((role = 'user') = (user_id IS NOT NULL))
);
CREATE INDEX idx_chat_review ON chat_messages(review_id, id);

CREATE INDEX idx_feedback_action ON feedback(action, finding_id);
