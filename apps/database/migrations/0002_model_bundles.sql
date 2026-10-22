-- Server model bundles. A run records the id of the bundle it was admitted under, so it can finish and settle
-- after a restart with another model configuration. Ids are content hashes, checked by the application on read.
-- The other model_lifecycle tables (activations, notices, cutoffs, ...) were never used and are dropped.
DROP VIEW model_lifecycle.notice_events;
DROP TABLE model_lifecycle.notice_deliveries, model_lifecycle.cutoffs, model_lifecycle.commands, model_lifecycle.head,
  model_lifecycle.activations, model_lifecycle.notices, model_lifecycle.evidence, model_lifecycle.identities;

ALTER TABLE model_lifecycle.bundles
  ADD CONSTRAINT bundles_id CHECK (id ~ '^server-[0-9a-f]{64}$' AND payload->>'id' = id),
  ADD CONSTRAINT bundles_size CHECK (octet_length(payload::text) <= 1048576);

CREATE FUNCTION app.register_model_bundle(bundle_id text, bundle jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO model_lifecycle.bundles (id, payload) VALUES (bundle_id, bundle) ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT FROM model_lifecycle.bundles WHERE id = bundle_id AND payload = bundle) THEN
    RAISE EXCEPTION 'Model bundle identity conflict' USING ERRCODE = '23505';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.register_model_bundle(text, jsonb) FROM PUBLIC;

CREATE FUNCTION app.model_bundle(bundle_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT payload FROM model_lifecycle.bundles WHERE id = bundle_id;
$$;
REVOKE ALL ON FUNCTION app.model_bundle(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'tulipfarm') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA model_lifecycle FROM tulipfarm;
    REVOKE USAGE ON SCHEMA model_lifecycle FROM tulipfarm;
  END IF;
END;
$$;
