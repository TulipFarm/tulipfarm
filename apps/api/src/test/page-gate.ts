/**
 * Test doubles for authored-Page read authorization.
 *
 * These live in `test/` rather than beside the gate so a permissive authorizer can never be reached
 * from production wiring. A suite that uses one is declaring that it is not the suite testing
 * access control — `page-access.pg.test.ts` is.
 */

import type { PageReadAuthorizer, ReadablePages } from "../knowledge/page-access";

/** Authorizes everything. For suites asserting routing and shape, not access. */
export function allowAllPages(): PageReadAuthorizer {
  return {
    canRead: async () => true,
    canReadSpace: async () => true,
    readableSpaceIds: async (_userId, spaceIds) => [...spaceIds],
    readablePageIds: async (_userId, pageIds): Promise<ReadablePages> => ({
      allowed: [...pageIds],
      excluded: 0,
    }),
  };
}
