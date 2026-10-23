-- GitHub webhook deliveries are kept only while redelivery deduplication needs them. The application role still may not
-- delete deliveries itself: this function removes one bounded batch of settled deliveries older than the retention
-- (1 to 720 hours) that no payload or dispatch references. Pending deliveries are never removed; they expire first.
CREATE INDEX github_event_delivery_settled ON app.github_event_deliveries(received_at) WHERE status <> 'pending';

CREATE FUNCTION app.prune_github_event_deliveries(retention_hours integer, batch_size integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  removed integer;
BEGIN
  IF retention_hours IS NULL OR retention_hours < 1 OR retention_hours > 720
    OR batch_size IS NULL OR batch_size < 1 OR batch_size > 1000 THEN
    RAISE EXCEPTION 'Invalid GitHub delivery retention' USING ERRCODE = '22023';
  END IF;
  DELETE FROM app.github_event_deliveries d
  USING (
    SELECT c.app_id, c.delivery_id FROM app.github_event_deliveries c
    WHERE c.status <> 'pending' AND c.received_at < clock_timestamp() - retention_hours * interval '1 hour'
      AND NOT EXISTS (SELECT FROM app.github_event_payloads p WHERE p.app_id = c.app_id AND p.delivery_id = c.delivery_id)
      AND NOT EXISTS (SELECT FROM app.github_event_dispatches t WHERE t.app_id = c.app_id AND t.delivery_id = c.delivery_id)
    ORDER BY c.received_at
    LIMIT batch_size
    FOR UPDATE OF c SKIP LOCKED
  ) settled
  WHERE d.app_id = settled.app_id AND d.delivery_id = settled.delivery_id AND d.status <> 'pending';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
REVOKE ALL ON FUNCTION app.prune_github_event_deliveries(integer, integer) FROM PUBLIC;
