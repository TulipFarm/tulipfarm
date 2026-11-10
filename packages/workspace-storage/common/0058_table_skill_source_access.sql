GRANT SELECT(id,enabled) ON {{schema}}.tf_workspace_skills TO {{migration}},{{customOwner}};
GRANT SELECT(skill_id,revision) ON {{schema}}.tf_workspace_skill_reviews TO {{migration}},{{customOwner}};
GRANT SELECT(skill_id,membership_id,permission) ON {{schema}}.tf_skill_person_grants TO {{migration}},{{customOwner}};
GRANT SELECT(skill_id,team_id,permission) ON {{schema}}.tf_skill_team_grants TO {{migration}},{{customOwner}};
