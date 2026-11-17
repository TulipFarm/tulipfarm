-- Slack is open by default: every member may use an installation and every admin may manage it.
-- Managers can narrow these grants later; this only backfills installations made before the default.
INSERT INTO {{schema}}.tf_slack_installation_grants (installation_id, team_id)
SELECT i.id, t.id
FROM {{schema}}.tf_slack_installations i
JOIN {{schema}}.tf_teams t ON t.name = '_everyone'
ON CONFLICT DO NOTHING;

INSERT INTO {{schema}}.tf_slack_installation_managers (installation_id, team_id)
SELECT i.id, t.id
FROM {{schema}}.tf_slack_installations i
JOIN {{schema}}.tf_teams t ON t.name = '_admin'
ON CONFLICT DO NOTHING;
