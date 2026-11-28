-- An all-repositories GitHub source skips forks. It keeps an excluded row for each fork so settings can show it.
ALTER TABLE {{schema}}.tf_knowledge_github_repositories ADD COLUMN fork boolean NOT NULL DEFAULT false;
