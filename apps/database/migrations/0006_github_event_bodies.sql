-- Every verified GitHub App delivery keeps its full body for one minute so workflow triggers can read it. The body
-- has no size check because real push and pull_request events exceed the 64 KiB limit of the Knowledge envelope.
-- Delivery rows stay for redelivery deduplication (see 0004); deleting one removes its body.
CREATE TABLE app.github_event_bodies (
  app_id text NOT NULL,
  delivery_id uuid NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (app_id,delivery_id),
  FOREIGN KEY (app_id,delivery_id) REFERENCES app.github_event_deliveries(app_id,delivery_id) ON DELETE CASCADE
);
REVOKE ALL ON TABLE app.github_event_bodies FROM PUBLIC;

CREATE FUNCTION app.prune_github_event_bodies(batch_size integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  removed integer;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 1000 THEN
    RAISE EXCEPTION 'Invalid GitHub body batch size' USING ERRCODE = '22023';
  END IF;
  DELETE FROM app.github_event_bodies b
  USING (
    SELECT c.app_id, c.delivery_id FROM app.github_event_bodies c
    JOIN app.github_event_deliveries d ON d.app_id = c.app_id AND d.delivery_id = c.delivery_id
    WHERE d.received_at < clock_timestamp() - interval '1 minute'
    ORDER BY d.received_at
    LIMIT batch_size
    FOR UPDATE OF c SKIP LOCKED
  ) old
  WHERE b.app_id = old.app_id AND b.delivery_id = old.delivery_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
REVOKE ALL ON FUNCTION app.prune_github_event_bodies(integer) FROM PUBLIC;
