// Generate .wrangler/seed.sql from standards/*.yaml and the demo users.
// Run through `npm run db:seed:local` (or `wrangler d1 execute DB --remote --file=.wrangler/seed.sql`).
//
// Re-seeding is safe: content fields are updated, `enabled` and its audit trail are left alone,
// and each new content version is added to standard_versions without touching old ones.
// A standard whose YAML file has been removed is retired (it stops running), never deleted, so the
// reviews that used it keep their history. Restoring the file un-retires it.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadStandards } from "./load-standards.ts";
import { DEMO_USERS } from "../core/demo-users.ts";

const q = (v: string | undefined | null): string => (v == null ? "NULL" : `'${v.replaceAll("'", "''")}'`);

const now = new Date().toISOString();
const standards = await loadStandards();
const sql: string[] = [];

for (const u of DEMO_USERS) {
  sql.push(`INSERT INTO users (id, name, role) VALUES (${q(u.id)}, ${q(u.name)}, ${q(u.role)})
  ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role;`);
}

for (const s of standards) {
  sql.push(`INSERT INTO standards (id, title, severity, detector, rule, compliant_example, violating_example, content_hash, enabled, updated_by, updated_at)
  VALUES (${q(s.id)}, ${q(s.title)}, ${q(s.severity)}, ${q(s.detector)}, ${q(s.rule)}, ${q(s.compliant)}, ${q(s.violating)}, ${q(s.contentHash)}, 1, NULL, ${q(now)})
  ON CONFLICT(id) DO UPDATE SET title = excluded.title, severity = excluded.severity, detector = excluded.detector,
    rule = excluded.rule, compliant_example = excluded.compliant_example, violating_example = excluded.violating_example,
    content_hash = excluded.content_hash, retired_at = NULL;`);
  // Same hash means same content (examples included), so filling the examples on an existing
  // version row (created before migration 0002) can't change what that version was.
  sql.push(`INSERT INTO standard_versions (standard_id, content_hash, title, severity, detector, rule, compliant_example, violating_example, first_seen_at)
  VALUES (${q(s.id)}, ${q(s.contentHash)}, ${q(s.title)}, ${q(s.severity)}, ${q(s.detector)}, ${q(s.rule)}, ${q(s.compliant)}, ${q(s.violating)}, ${q(now)})
  ON CONFLICT(standard_id, content_hash) DO UPDATE SET
    compliant_example = excluded.compliant_example, violating_example = excluded.violating_example;`);
}

sql.push(`UPDATE standards SET retired_at = ${q(now)}
  WHERE retired_at IS NULL AND id NOT IN (${standards.map((s) => q(s.id)).join(", ")});`);

const outDir = fileURLToPath(new URL("../.wrangler/", import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}seed.sql`, sql.join("\n") + "\n");
console.log(`Wrote .wrangler/seed.sql: ${DEMO_USERS.length} users, ${standards.length} standards`);
