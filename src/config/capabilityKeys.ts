// Capability keys mapped to ParseFusion UI features and navigation items.
// These match or correspond to the capabilities array returned by GET /auth/me.
// The backend team can edit these constant keys as needed.

export const CAPABILITY_KEYS = {
  // Navigation & Feature capabilities
  UPLOAD: "documents:upload",
  BATCH_VIEW: "batch:view",
  DASHBOARD_VIEW: "dashboard:view",
  SOURCE_VIEW: "documents:view",
  DOCUMENT_REQUEST: "documents:request",
  CASE_REVIEW: "cases:review",
  CASE_DECISION: "cases:decide",
  ACTION_DRAFT: "actions:draft",
  ACTION_APPROVE: "actions:approve",
  ACCESS_BROWSE: "access:browse",
  ACCESS_REQUEST: "access:request",
  ACCESS_ADMIN: "access:admin",
  CHAT_SQL: "chat:sql",
  EXPORT_CREATE: "export:create",
  EXPORT_VIEW: "export:view",
  AUDIT_VIEW: "audit:view",
  METRICS_VIEW: "metrics:view",
  HEALTH_VIEW: "system:health",
  ADMIN_SETTINGS: "admin:settings",
} as const;

export type CapabilityKey =
  (typeof CAPABILITY_KEYS)[keyof typeof CAPABILITY_KEYS];

/**
 * Checks whether user has the required capability.
 * If user capabilities include "*" or "admin:*", it grants access.
 */
export function hasCapability(
  userCapabilities: string[] | undefined,
  requiredCapability: string
): boolean {
  if (!userCapabilities || userCapabilities.length === 0) return false;
  if (
    userCapabilities.includes("*") ||
    userCapabilities.includes("admin:*") ||
    userCapabilities.includes("superuser")
  ) {
    return true;
  }
  return userCapabilities.includes(requiredCapability);
}
