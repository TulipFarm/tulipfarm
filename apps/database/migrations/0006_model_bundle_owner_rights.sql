-- 0002 revoked model_lifecycle rights from the tulipfarm role. When tulipfarm also runs migrations, as in local
-- development and self-hosting, it owns model_lifecycle and the SECURITY DEFINER model bundle functions, so the
-- revoke left those functions unable to read or write bundles. Give each owner back its default rights.
DO $$
DECLARE
  owned record;
BEGIN
  FOR owned IN
    SELECT format('SCHEMA %I', nspname) AS object, 'USAGE, CREATE' AS rights, nspowner AS owner
    FROM pg_namespace WHERE nspname = 'model_lifecycle'
    UNION ALL
    SELECT format('TABLE %I.%I', n.nspname, c.relname), 'ALL', c.relowner
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'model_lifecycle' AND c.relkind IN ('r', 'v')
  LOOP
    IF pg_has_role(current_user, owned.owner, 'USAGE') THEN
      EXECUTE format('GRANT %s ON %s TO %I', owned.rights, owned.object, pg_get_userbyid(owned.owner));
    END IF;
  END LOOP;
END;
$$;
