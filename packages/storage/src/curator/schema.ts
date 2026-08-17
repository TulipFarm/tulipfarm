/**
 * The Curator's tables.
 *
 * Split from `repo.ts` only because that file outgrew the 600-line cap; DDL and the reads that use
 * it are one concern, and `work.ts` and `admission.ts` still keep theirs inline.
 */
export const CURATOR_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS curator_job (
    id              uuid PRIMARY KEY,
    business_id     text NOT NULL,
    scope           text NOT NULL CHECK (scope IN ('user', 'business')),
    user_id         text,
    run_id          text,
    state           text NOT NULL DEFAULT 'minted'
                      CHECK (state IN ('minted','running','succeeded','failed','cancelled')),
    execution_mode  text NOT NULL CHECK (execution_mode IN ('shadow', 'apply')),
    manifest_digest text NOT NULL CHECK (length(manifest_digest) > 0),
    manifest        jsonb NOT NULL,
    context_pin     jsonb,
    output_digest   text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK ((scope = 'user') = (user_id IS NOT NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS curator_job_target_idx
     ON curator_job (business_id, scope, user_id, created_at DESC)`,
  // One live job per target, enforced where the race is rather than compensated for afterwards.
  // The alternative — mint, discover the clash, then unwind the Run and return the claimed work to
  // `due` — is a compensating transaction across a persist-first boundary, and a crash inside it
  // strands the claims. Two partial indexes rather than one over `coalesce(user_id,'')` so neither
  // scope's constraint is expressed in terms of the other's sentinel.
  `CREATE UNIQUE INDEX IF NOT EXISTS curator_job_live_user_idx
     ON curator_job (business_id, user_id)
     WHERE scope = 'user' AND state IN ('minted', 'running')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS curator_job_live_business_idx
     ON curator_job (business_id)
     WHERE scope = 'business' AND state IN ('minted', 'running')`,
  `CREATE TABLE IF NOT EXISTS curator_effect (
    id              text PRIMARY KEY,
    job_id          uuid NOT NULL REFERENCES curator_job(id) ON DELETE CASCADE,
    business_id     text NOT NULL,
    kind            text NOT NULL CHECK (kind IN
                      ('memory_patch','proposal','knowledge_promotion','knowledge_page',
                       'proposal_seed')),
    generation      integer NOT NULL DEFAULT 1,
    execution_mode  text NOT NULL CHECK (execution_mode IN ('shadow', 'apply')),
    state           text NOT NULL CHECK (state IN
                      ('pending','applying','succeeded','retryable_failed','superseded',
                       'terminal_rejected','shadowed')),
    payload         jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- Enabling the loop must never be able to apply what it produced while in shadow, so a shadow
    -- effect is born terminal and has no state it could later be advanced out of.
    CONSTRAINT curator_effect_shadow_is_terminal
      CHECK (execution_mode <> 'shadow' OR state = 'shadowed')
  )`,
  `CREATE INDEX IF NOT EXISTS curator_effect_job_idx ON curator_effect (job_id, generation)`,
  // The shadow review surface reads a business's recent effects, and the ledger keeps every effect
  // of every job — so without this the one read an operator makes before go-live is a full scan.
  `CREATE INDEX IF NOT EXISTS curator_effect_review_idx
     ON curator_effect (business_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS curator_rejection (
    id          bigserial PRIMARY KEY,
    job_id      uuid NOT NULL REFERENCES curator_job(id) ON DELETE CASCADE,
    effect      text NOT NULL,
    reason      text NOT NULL,
    detail      text,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS curator_rejection_job_idx ON curator_rejection (job_id)`,
  `CREATE TABLE IF NOT EXISTS curator_candidate (
    id            uuid PRIMARY KEY,
    business_id   text NOT NULL,
    direction     text NOT NULL
                    CHECK (direction IN ('knowledge_promotion', 'proposal_seed')),
    user_id       text,
    source_job_id uuid REFERENCES curator_job(id) ON DELETE SET NULL,
    payload       jsonb NOT NULL,
    state         text NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'consumed', 'expired')),
    created_at    timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS curator_candidate_open_idx
     ON curator_candidate (business_id, direction, created_at)
     WHERE state = 'open'`,
  // 1:1 on `tasks`, which stays the only lifecycle row: no status, audience or dedupe here, or the
  // two would need keeping in sync and would eventually disagree.
  `CREATE TABLE IF NOT EXISTS curator_task_metadata (
    task_id     uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    business_id text NOT NULL,
    kind        text NOT NULL,
    deliver     text[] NOT NULL CHECK (array_length(deliver, 1) > 0),
    citations   jsonb NOT NULL DEFAULT '[]'::jsonb,
    rationale   text,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`,
];
