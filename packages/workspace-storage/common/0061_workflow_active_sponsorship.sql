ALTER TABLE {{schema}}.tf_workflows
  ADD COLUMN sponsorship_active_revision uuid,
  ADD FOREIGN KEY (id, sponsorship_active_revision)
    REFERENCES {{schema}}.tf_workflow_revisions(workflow_id, id);

UPDATE {{schema}}.tf_workflows
SET sponsorship_active_revision = active_revision
WHERE enabled AND sponsorship_id IS NOT NULL AND sponsorship_revision = active_revision;

GRANT UPDATE (sponsorship_active_revision) ON {{schema}}.tf_workflows TO {{runtime}};

CREATE FUNCTION {{schema}}.tf_clear_active_sponsorship() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.sponsorship_id IS DISTINCT FROM OLD.sponsorship_id
    OR NEW.sponsor_membership_id IS DISTINCT FROM OLD.sponsor_membership_id THEN
    NEW.sponsorship_active_revision := NULL;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_clear_active_sponsorship() FROM PUBLIC;

CREATE TRIGGER tf_workflow_active_sponsorship
BEFORE UPDATE OF sponsorship_id, sponsor_membership_id ON {{schema}}.tf_workflows
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_clear_active_sponsorship();
