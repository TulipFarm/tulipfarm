ALTER TABLE {{schema}}.tf_agent_activations
  ADD COLUMN superseded_by_activation_id uuid REFERENCES {{schema}}.tf_agent_activations(id),
  ADD COLUMN superseded_at timestamptz,
  ADD CONSTRAINT tf_agent_activation_replacement_pair
    CHECK ((superseded_by_activation_id IS NULL) = (superseded_at IS NULL)),
  ADD CONSTRAINT tf_agent_activation_replacement_not_self
    CHECK (superseded_by_activation_id IS DISTINCT FROM id);

GRANT UPDATE(superseded_by_activation_id,superseded_at)
  ON {{schema}}.tf_agent_activations TO {{runtime}};
