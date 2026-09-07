export const WEBHOOK_INBOX_DISPATCH_MIGRATION_STATEMENTS: readonly string[] = [
  `ALTER TABLE webhook_deliveries
     DROP CONSTRAINT IF EXISTS webhook_deliveries_state_check`,
  `ALTER TABLE webhook_deliveries
     ADD CONSTRAINT webhook_deliveries_state_check
     CHECK (state IN ('accepted', 'normalized', 'dispatched', 'dead_letter'))`,
  `DROP INDEX IF EXISTS webhook_deliveries_claim_idx`,
  `CREATE INDEX webhook_deliveries_claim_idx
     ON webhook_deliveries (state, next_attempt_at)
     WHERE state IN ('accepted', 'normalized')`,
];
