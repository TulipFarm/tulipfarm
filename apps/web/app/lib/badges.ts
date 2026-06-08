/*
 * Mocked badge counts for the V1 shell scaffold. Real counts wire to the API in downstream
 * tickets (e.g. Approvals → GET /api/v1/approvals). A pill renders only when the count is > 0.
 */
export type BadgeKey = "approvals";

export const badgeCounts: Record<BadgeKey, number> = {
  approvals: 3,
};
