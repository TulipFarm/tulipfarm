/**
 * How the Curator knows what it has already read.
 *
 * One row per person, not a flag per Conversation. A Conversation keeps receiving Turns, so a
 * `curated` boolean on it is true at 15:00 and wrong at 15:01; a watermark answers the question
 * that is actually being asked — "what has this person said since T?" — and only ever moves
 * forward.
 *
 * A person with no row reads as `epoch`, so a fresh instance backfills its whole history through
 * the ordinary hourly path, one bounded batch per tick. There is no separate backfill job because
 * there is nothing for one to do differently.
 */
export const MEMORY_CURATION_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memory_curation_watermark (
    business_id     text        NOT NULL,
    user_id         text        NOT NULL,
    curated_through timestamptz NOT NULL,
    last_run_at     timestamptz,
    failures        integer     NOT NULL DEFAULT 0 CHECK (failures >= 0),
    PRIMARY KEY (business_id, user_id)
  )`,
  // The cross-user scan is "every Turn newer than T", which no existing index serves:
  // `conversation_turns_conversation_idx` leads with `conversation_id`, so answering it today
  // means a sequential scan of every Turn the instance has ever run.
  //
  // Guarded on the table's existence because this list is applied by a migration, and a migration
  // may run against a database that recorded the Turn schema as applied without holding it.
  `DO $$
   BEGIN
     IF to_regclass('public.conversation_turns') IS NULL THEN RETURN; END IF;
     EXECUTE 'CREATE INDEX IF NOT EXISTS conversation_turns_created_idx
                ON conversation_turns (created_at)';
   END $$`,
];
