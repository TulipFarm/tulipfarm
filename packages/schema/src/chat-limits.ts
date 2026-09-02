/**
 * Chat constants with no TypeBox import, so a UI that needs one does not pull the validator.
 *
 * The sidebar's rename control reaches `CHAT_TITLE_MAX_LENGTH`, and while it sat beside the schema
 * builders in `chat.ts` that single number put 42KB of TypeBox on the web app's critical path.
 * `chat.ts` re-exports everything here, so importing from either module is equivalent.
 */

/**
 * Longest title a Chat may carry. Shared so the API's rename schema and every UI that offers a
 * rename enforce the same ceiling — a client-side `maxLength` that disagreed with the route would
 * turn a typo into a 400 the user cannot see the cause of.
 */
export const CHAT_TITLE_MAX_LENGTH = 200;
