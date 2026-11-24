// Authorisation rules as pure functions, so every rule has a unit test and the Worker cannot
// enforce them differently in different routes. PR 3-C adds the exception rules here.
import type { User } from "./types.ts";

export type Decision = { ok: true } | { ok: false; code: "forbidden"; message: string };

const allow: Decision = { ok: true };
const deny = (message: string): Decision => ({ ok: false, code: "forbidden", message });

export function canToggleStandard(user: User): Decision {
  return user.role === "approver" ? allow : deny("Only approvers can enable or disable standards.");
}

/**
 * Only the review's author, or an approver, can challenge its findings (review of PR #3, item 3).
 * A finding can be challenged once, so without this anyone could use up the author's challenge
 * with a junk argument.
 */
export function canChallenge(user: User, reviewAuthorId: string): Decision {
  return user.role === "approver" || user.id === reviewAuthorId ? allow : deny("Only the author of the review or an approver can challenge its findings.");
}
