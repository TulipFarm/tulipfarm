# Sourced by compose-parity.sh; uses its isolated Compose project, image, and cleanup trap.

runtime_identity() {
  compose exec -T postgres psql -U tulipfarm -d tulipfarm -At -v ON_ERROR_STOP=1 \
    -c "SELECT installation_id || '|' || business_id || '|' || hosting_authority FROM deployment_runtime_identity"
}

runtime_assert_agreement() {
  local expected="$1" service identity
  identity="${expected%%|*}"
  [ "$(runtime_identity)" = "$expected" ] || fail "persisted deployment association changed"
  [[ "$expected" =~ ^[0-9a-f-]{36}\|tulipfarm-local\|independent$ ]] \
    || fail "independent identity is missing or the legacy business identifier changed"
  for service in app worker integration-worker; do
    grep -Fq "Runtime installation ${identity} (independent)" <<<"$(compose logs --no-color "$service")" \
      || fail "${service} did not initialize the persisted identity"
    [ "$(compose exec -T "$service" printenv NODE_ENV)" = production ] \
      || fail "${service} is not running production code"
    [ "$(docker inspect --format '{{.Image}}' "$(compose ps -q "$service")")" = \
      "$(docker image inspect --format '{{.Id}}' "$IMAGE")" ] \
      || fail "${service} did not run the shared candidate image"
  done
  compose exec -T integration-worker node -e \
    "fetch('http://localhost:4030/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    || fail "integration-worker did not report ready"
}

runtime_assert_artifact() {
  log "checking the actual image for entrypoints and persisted credentials…"
  docker run --rm --entrypoint node "$IMAGE" -e '
    const fs = require("node:fs");
    for (const entry of ["server.cjs", "worker.cjs", "integration-worker.cjs"]) {
      if (!fs.statSync(`/app/${entry}`).isFile()) throw Error(`Missing ${entry}`);
    }
    for (const dir of ["/data", "/opt/tulipfarm/soul"]) {
      if (fs.readdirSync(dir).length) throw Error(`Image contains persisted state: ${dir}`);
    }
    function inspect(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        if (/^\.env($|\.)|^(secrets|worker|integration-worker|bucket)\.env$/.test(entry.name)) {
          throw Error(`Image contains environment file: ${dir}/${entry.name}`);
        }
        if (entry.isDirectory()) inspect(`${dir}/${entry.name}`);
      }
    }
    inspect("/app");
    for (const key of ["ADMIN_PASSWORD", "LLM_API_KEY", "ENCRYPTION_KEY",
      "WORKER_API_CREDENTIAL", "INTEGRATION_WORKER_API_CREDENTIAL", "RUNTIME_INSTALLATION_ID"]) {
      if (process.env[key]) throw Error(`Image contains seeded ${key}`);
    }
    if (process.env.NODE_ENV !== "production") throw Error("Image is not production");
  ' || fail "runtime artifact validation failed"
}

runtime_assert_public_projection() {
  log "checking packaged health/setup responses and browser assets for credential exposure…"
  compose exec -T app node -e '
    const fs = require("node:fs");
    const values = [];
    for (const name of ["secrets.env", "worker.env", "integration-worker.env", "bucket.env"]) {
      const path = `/data/${name}`;
      if (!fs.existsSync(path)) continue;
      for (const line of fs.readFileSync(path, "utf8").split("\n")) {
        const value = line.slice(line.indexOf("=") + 1).trim();
        if (line.includes("=") && value.length >= 16) values.push(value);
      }
    }
    if (!values.length) throw Error("No credential sentinels available for exposure check");
    function check(text) {
      if (values.some(value => text.includes(value))) throw Error("Credential exposed");
    }
    function inspect(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) inspect(path);
        else check(fs.readFileSync(path, "utf8"));
      }
    }
    inspect(process.env.WEB_DIST);
    (async () => {
      for (const path of ["/health", "/readyz", "/api/v1/setup/status"]) {
        const response = await fetch(`http://localhost:8080${path}`);
        if (!response.ok) throw Error(`Failed public projection: ${path}`);
        check(await response.text());
      }
    })().catch(() => process.exit(1));
  ' || fail "packaged public projection exposed credentials or was unavailable"
}

runtime_assert_rejected() {
  local service="$1" authority="$2" installation="$3" expected="$4"
  local container state output attempt port
  case "$service" in
    app) port=8080 ;;
    worker) port=4020 ;;
    integration-worker) port=4030 ;;
    *) fail "unknown runtime service: $service" ;;
  esac
  container="$(compose run -d --no-deps \
    -e "RUNTIME_HOSTING_AUTHORITY=$authority" -e "RUNTIME_INSTALLATION_ID=$installation" \
    "$service")"
  docker update --restart=no "$container" >/dev/null
  for attempt in $(seq 1 45); do
    state="$(docker inspect --format '{{.State.Status}}' "$container")"
    [ "$state" = exited ] && break
    # Any listener is a failure, even if readiness claims 503 or setup claims to be closed.
    if docker exec "$container" node -e '
      const port = process.argv[1];
      Promise.all(["/readyz", "/api/v1/setup/status"].map(path =>
        fetch(`http://localhost:${port}${path}`, {signal: AbortSignal.timeout(500)})
          .then(() => true, () => false))).then(results => process.exit(results.some(Boolean) ? 0 : 1));
    ' "$port" >/dev/null 2>&1; then
      docker rm -f "$container" >/dev/null
      fail "${service} opened a listener with rejected deployment configuration"
    fi
    sleep 1
  done
  output="$(docker logs "$container" 2>&1)"
  if [ "$state" != exited ] || [ "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 0 ]; then
    docker rm -f "$container" >/dev/null
    fail "${service} did not fail closed within 45 seconds"
  fi
  docker rm "$container" >/dev/null
  grep -Fq "$expected" <<<"$output" || fail "${service} failed for an unexpected reason"
  if grep -Fq "secret-sentinel" <<<"$output"; then
    fail "${service} leaked malformed operator configuration"
  fi
}

runtime_assert_fail_closed() {
  local service
  log "checking production hosted refusal and identity mismatch on all entrypoints…"
  for service in app worker integration-worker; do
    runtime_assert_rejected "$service" "secret-sentinel" "" \
      "RUNTIME_HOSTING_AUTHORITY must be independent or tulipfarm"
    runtime_assert_rejected "$service" tulipfarm "" "RUNTIME_INSTALLATION_ID is required"
    runtime_assert_rejected "$service" tulipfarm "secret-sentinel" \
      "RUNTIME_INSTALLATION_ID must be a UUID"
    runtime_assert_rejected "$service" tulipfarm "11111111-1111-4111-8111-111111111111" \
      "no production hosted identity protocol"
    runtime_assert_rejected "$service" independent "11111111-1111-4111-8111-111111111111" \
      "RUNTIME_INSTALLATION_ID conflicts with the persisted runtime identity"
  done
}

runtime_prepare_legacy_fixture() {
  log "preparing isolated pre-foundation database fixture (not a supported downgrade)…"
  compose stop app worker integration-worker
  [ "$(compose exec -T postgres psql -U tulipfarm -d tulipfarm -At \
    -c "SELECT version FROM schema_version")" = 138 ] \
    || fail "update the isolated legacy fixture for this candidate's migration boundary"
  compose exec -T postgres psql -U tulipfarm -d tulipfarm -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DROP TABLE native_channel_routine_routes;
DROP TABLE native_channel_inbox;
DROP TABLE mcp_knowledge_source_links;
DROP TABLE mcp_knowledge_selections;
DROP TABLE mcp_execution_authorizations;
DROP TABLE mcp_oauth_refresh_claims;
DROP TABLE mcp_oauth_attempts;
DROP TABLE mcp_chat_account_selections;
DROP TABLE mcp_account_grants;
DROP TABLE mcp_accounts;
DROP TABLE deployment_runtime_identity;
DROP TRIGGER api_clients_sync_operational_principal ON api_clients;
DROP FUNCTION sync_operational_client_principal();
ALTER TABLE api_clients DROP COLUMN operational_scope;
ALTER TABLE principals DROP COLUMN operational_scope;
DELETE FROM schema_migrations WHERE version IN (134, 135, 136, 137, 138);
UPDATE schema_version SET version = 133;
COMMIT;
SQL
  compose rm -f app worker integration-worker >/dev/null
}
