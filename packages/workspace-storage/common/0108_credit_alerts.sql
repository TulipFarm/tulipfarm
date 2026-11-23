-- A model call paid by a member's plan or an own API key is charged a fee on its list-price value. The fee, in credit
-- units before rounding, joins the flow's aggregate with the provider cost of its credit-paid calls; provider_pico_usd
-- stays the real provider cost, which is 0 for those calls.
ALTER TABLE {{schema}}.tf_credit_usage
  ADD COLUMN fee_units numeric(30,0) NOT NULL DEFAULT 0 CHECK (fee_units >= 0);
GRANT UPDATE (fee_units) ON {{schema}}.tf_credit_usage TO {{runtime}};

-- The last credit alert sent to the workspace's admins: 'low' (90% of granted credits used), 'grace' (the balance
-- reached zero and grace credits are in use) or 'stopped' (grace used up). It clears when a top-up lifts the balance
-- back above the levels, so each crossing alerts once.
CREATE TABLE {{schema}}.tf_credit_alerts (
  id integer PRIMARY KEY CHECK (id = 1),
  level text CHECK (level IN ('low','grace','stopped')),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON {{schema}}.tf_credit_alerts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_credit_alerts TO {{runtime}};
