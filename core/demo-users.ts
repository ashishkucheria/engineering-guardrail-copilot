import type { User } from "./types.ts";

/**
 * Demo identities for the identity picker. This is NOT authentication: the API trusts the
 * X-Demo-User header. Production would use Cloudflare Access with roles from the identity provider.
 */
export const DEMO_USERS: readonly User[] = [
  { id: "dev-asha", name: "Asha (developer)", role: "developer" },
  { id: "dev-marco", name: "Marco (developer)", role: "developer" },
  { id: "appr-ravi", name: "Ravi (approver)", role: "approver" },
  { id: "appr-lena", name: "Lena (approver)", role: "approver" },
];
