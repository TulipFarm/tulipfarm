export const OPERATIONAL_PRINCIPAL_STATEMENTS = [
  "ALTER TABLE principals ADD COLUMN IF NOT EXISTS operational_scope jsonb",
  `ALTER TABLE api_clients ADD COLUMN operational_scope jsonb
    CHECK (operational_scope IS NULL OR (
      jsonb_typeof(operational_scope) = 'object'
      AND operational_scope ?& ARRAY['businessId', 'installationId']
      AND jsonb_typeof(operational_scope->'businessId') = 'string'
      AND jsonb_typeof(operational_scope->'installationId') = 'string'
      AND length(operational_scope->>'businessId') > 0
      AND length(operational_scope->>'installationId') > 0
    ))`,
  `CREATE FUNCTION sync_operational_client_principal() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.operational_scope IS DISTINCT FROM NEW.operational_scope THEN
        RAISE EXCEPTION 'operational client scope is immutable';
      END IF;
      IF NEW.operational_scope IS NOT NULL THEN
        INSERT INTO principals (business_id, id, kind, status, expires_at, operational_scope)
        VALUES (NEW.operational_scope->>'businessId', NEW.id, 'service', NEW.status,
                NEW.expires_at, NEW.operational_scope)
        ON CONFLICT (business_id, id) DO UPDATE SET
          kind = 'service', status = EXCLUDED.status, expires_at = EXCLUDED.expires_at,
          operational_scope = EXCLUDED.operational_scope, updated_at = now();
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`,
  `CREATE TRIGGER api_clients_sync_operational_principal
     AFTER INSERT OR UPDATE ON api_clients
     FOR EACH ROW EXECUTE FUNCTION sync_operational_client_principal()`,
] as const;
