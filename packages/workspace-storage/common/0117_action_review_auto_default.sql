-- Switch existing workspaces that have not opted into an explicit Ask rule from legacy to auto.
UPDATE {{schema}}.tf_action_review
SET mode = 'auto'
WHERE id = 1 AND mode = 'legacy';
