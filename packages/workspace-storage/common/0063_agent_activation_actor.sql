ALTER TABLE {{schema}}.tf_agent_activations
  ADD COLUMN activated_by_membership_id uuid REFERENCES {{schema}}.tf_memberships(id);
