// Authorisation rules as pure functions, so every rule has a unit test and the Worker cannot
// enforce them differently in different routes.
import type { User } from "./types.ts";

/** `forbidden` maps to 403 (role or ownership), `conflict` to 409 (the object's state). */
export type Decision = { ok: true } | { ok: false; code: "forbidden" | "conflict"; message: string };

const allow: Decision = { ok: true };
const deny = (message: string): Decision => ({ ok: false, code: "forbidden", message });
const conflict = (message: string): Decision => ({ ok: false, code: "conflict", message });

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

/**
 * Accept or reject a finding: the review's author or an approver (prompt 10). Otherwise anyone could
 * mark other people's findings rejected and skew the dashboard's reject rates. Feedback never
 * changes the finding or the verdict.
 */
export function canGiveFeedback(user: User, reviewAuthorId: string): Decision {
  return user.role === "approver" || user.id === reviewAuthorId ? allow : deny("Only the author of the review or an approver can accept or reject its findings.");
}

/**
 * Request an exception. Anyone may request one for a path in general (it stays pending until an
 * approver decides). One requested from a finding can waive that review once approved, so it
 * follows the same rule as feedback: the review's author or an approver.
 */
export function canRequestException(user: User, sourceReviewAuthorId: string | null): Decision {
  if (sourceReviewAuthorId === null) return allow;
  return user.role === "approver" || user.id === sourceReviewAuthorId ? allow : deny("Only the author of the review or an approver can request an exception from its findings.");
}

/**
 * Approve or deny an exception (design §4): approvers only, never their own request, and only while
 * it is pending. The database backs the second rule with a CHECK constraint, and the third with a
 * conditional update.
 */
export function canDecideException(user: User, e: { requestedBy: string; status: string }): Decision {
  if (user.role !== "approver") return deny("Only approvers can approve or deny exceptions.");
  if (user.id === e.requestedBy) return deny("You can't decide your own exception request; another approver has to.");
  if (e.status !== "pending") return conflict(`This exception was already ${e.status}.`);
  return allow;
}

/**
 * Chat about a review: its author or an approver, like feedback (review of PR #4, item 3). Every
 * question spends a model call from the shared daily budget, so a bystander mustn't be able to
 * spend it on someone else's review.
 */
export function canChat(user: User, reviewAuthorId: string): Decision {
  return user.role === "approver" || user.id === reviewAuthorId ? allow : deny("Only the author of the review or an approver can chat about it.");
}

/**
 * Revoking ends an approved exception early. Any approver may do it, the original approver or
 * requester included: it only narrows what is waived. Pending, denied, already revoked or expired
 * exceptions have nothing to revoke (409).
 */
export function canRevokeException(user: User, e: { status: string; expiresAt: string }, now: Date): Decision {
  if (user.role !== "approver") return deny("Only approvers can revoke exceptions.");
  if (e.status !== "approved") return conflict(`This exception is ${e.status}, so there is nothing to revoke.`);
  if (Date.parse(e.expiresAt) <= now.getTime()) return conflict("This exception has already expired.");
  return allow;
}
