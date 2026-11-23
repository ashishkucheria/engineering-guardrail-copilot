-- Review of PR #2 (prompt 4):
-- 1. Keep the compliant/violating examples per version. They are part of the content hash and of
--    the LLM prompt (PR 3-B), so a past review's prompt must be reproducible from its version.
-- 2. A standard whose YAML file is removed is retired by the seed script instead of staying
--    enabled forever. Retired standards never run and can't be toggled; their history stays.

ALTER TABLE standard_versions ADD COLUMN compliant_example TEXT;
ALTER TABLE standard_versions ADD COLUMN violating_example TEXT;

ALTER TABLE standards ADD COLUMN retired_at TEXT;
