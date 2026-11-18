-- A member can connect up to five accounts per provider. Each connection can be turned on or off for chats and for
-- coding runs; any number can be on, and a signed-out connection keeps its choices but is not used. An attempt can
-- target one connection to reconnect it, and a chat turn can name the connection its member picked to answer first.
-- A turn also records the connection that answered and, when it moved off another one, that connection and why.
ALTER TABLE {{schema}}.tf_subscription_connections
  DROP CONSTRAINT tf_subscription_connections_owner_membership_id_provider_key,
  ADD COLUMN use_for_chat boolean NOT NULL DEFAULT true,
  ADD COLUMN use_for_coding boolean NOT NULL DEFAULT true;
CREATE INDEX tf_subscription_connections_owner
  ON {{schema}}.tf_subscription_connections (owner_membership_id, provider);
GRANT UPDATE (use_for_chat, use_for_coding) ON {{schema}}.tf_subscription_connections TO {{runtime}};

ALTER TABLE {{schema}}.tf_subscription_connection_attempts
  ADD COLUMN connection_id uuid REFERENCES {{schema}}.tf_subscription_connections(id);

ALTER TABLE {{schema}}.tf_conversation_turns
  ADD COLUMN plan_connection_id uuid,
  ADD COLUMN plan_connection_used uuid,
  ADD COLUMN plan_switched_from uuid,
  ADD COLUMN plan_switch_reason text CHECK (plan_switch_reason IN ('usage-limit', 'reconnect', 'not-eligible'));
GRANT UPDATE (plan_connection_used, plan_switched_from, plan_switch_reason) ON {{schema}}.tf_conversation_turns TO {{runtime}};
