CREATE TABLE {{schema}}.tf_provenance (
  id uuid PRIMARY KEY,
  inputs uuid[] NOT NULL CHECK (cardinality(inputs) <= 1024 AND array_position(inputs, id) IS NULL),
  direct jsonb NOT NULL CHECK (direct ? 'kind' AND direct->>'kind' IN ('known', 'legacy-unknown')),
  closure jsonb NOT NULL CHECK (closure ? 'kind' AND closure->>'kind' IN ('known', 'legacy-unknown')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE {{schema}}.tf_project_provenance_revisions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.tf_projects(id),
  provenance_id uuid NOT NULL REFERENCES {{schema}}.tf_provenance(id),
  UNIQUE (project_id, id)
);

CREATE TABLE {{schema}}.tf_provenance_artifacts (
  provenance_id uuid NOT NULL REFERENCES {{schema}}.tf_provenance(id),
  message_id uuid REFERENCES {{schema}}.tf_conversation_messages(id),
  turn_id uuid REFERENCES {{schema}}.tf_conversation_turns(id),
  tool_result_id uuid REFERENCES {{schema}}.tf_conversation_tool_calls(id),
  request_id uuid REFERENCES {{schema}}.tf_conversation_requests(id),
  response_id uuid REFERENCES {{schema}}.tf_conversation_responses(id),
  approval_request_id uuid REFERENCES {{schema}}.tf_conversation_approval_requests(id),
  approval_resolution_id uuid REFERENCES {{schema}}.tf_conversation_approval_resolutions(request_id),
  kind text GENERATED ALWAYS AS (CASE
    WHEN message_id IS NOT NULL THEN 'message'
    WHEN turn_id IS NOT NULL THEN 'turn'
    WHEN tool_result_id IS NOT NULL THEN 'tool-result'
    WHEN request_id IS NOT NULL THEN 'request'
    WHEN response_id IS NOT NULL THEN 'response'
    WHEN approval_request_id IS NOT NULL THEN 'approval-request'
    WHEN approval_resolution_id IS NOT NULL THEN 'approval-resolution'
  END) STORED,
  artifact_id uuid GENERATED ALWAYS AS (COALESCE(message_id,turn_id,tool_result_id,request_id,response_id,approval_request_id,approval_resolution_id)) STORED,
  CHECK (num_nonnulls(message_id,turn_id,tool_result_id,request_id,response_id,approval_request_id,approval_resolution_id) = 1),
  PRIMARY KEY (kind, artifact_id)
);

REVOKE ALL ON {{schema}}.tf_provenance, {{schema}}.tf_provenance_artifacts, {{schema}}.tf_project_provenance_revisions FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_provenance, {{schema}}.tf_provenance_artifacts, {{schema}}.tf_project_provenance_revisions TO {{runtime}}, {{confirmation}};
GRANT SELECT (id, enabled, deleted_at) ON {{schema}}.tf_integrations TO {{confirmation}};
GRANT SELECT (id, integration_id) ON {{schema}}.tf_integration_sources TO {{confirmation}};
GRANT SELECT (integration_id, team_id, permission) ON {{schema}}.tf_integration_grants TO {{confirmation}};
GRANT SELECT (source_id, team_id, permission) ON {{schema}}.tf_integration_source_grants TO {{confirmation}};
