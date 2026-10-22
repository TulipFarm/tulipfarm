import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { availableParallelism, totalmem } from 'node:os';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { credentialKeyring, decryptCredential } from '../../../packages/workspaces/src/credentials.ts';
import { createWorkspaceMaintenance } from '@tulipfarm/workspaces/lifecycle';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';
import { soulStorageConfig } from '@tulipfarm/workspaces/soul';
import { workspaceRuntime } from '@tulipfarm/workspaces/storage';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../../packages/tables/test/fixture.mjs';
import {
  rolloutCommonMigrations,
  verifyWorkspaceIsolation,
} from '../../../packages/workspace-storage/src/provisioning.ts';
import { workspaceNames } from '../../../packages/workspace-storage/src/runtime.ts';
import { createAuth } from '../../api/src/auth.ts';
import { createTemporalClient } from '../../api/src/temporal.ts';
import { readMigrations } from '../../database/src/migrations.ts';
import { grantApplicationAccess } from '../../database/src/postgres.ts';
import { startNativePostgres } from './capacity-native-postgres.mjs';

const dimensions = {
  fixtureWorkspaces: 100,
  tablesPerWorkspace: 2,
  recordsPerTable: 100,
  fieldsPerTable: 2,
  apiProcesses: 2,
  ordinaryWorkerProcesses: 2,
  maintenanceProcesses: 1,
  httpUsers: 2,
  trafficLanesPerApi: 4,
  lanePauseMs: 25,
  baselineMs: 10000,
  mixedMinimumMs: 60000,
  newHttpWorkspacesDuringRollout: 2,
  rolloutConcurrency: 4,
  rolloutPausePerWorkspaceMs: 2000,
  sampleIntervalMs: 20,
  runtimePoolsPerProcess: 8,
  connectionsPerRuntimePool: 2,
  runtimeTransactionConcurrency: 8,
};
const budgets = {
  provisional: true,
  scope: 'local disposable PostgreSQL and local Temporal, real local-environment R2; not an Azure guarantee',
  sampledDatabaseConnectionsMaximum: 120,
  recordHttpP95MsExclusive: 500,
  unauthorizedResultsMaximum: 0,
  failedGrantChecksMaximum: 0,
  unexpectedHttpErrorsMaximum: 0,
  automaticMigrationDeadlineMs: 120000,
  rolloutDeadlineMs: 180000,
};
const enabled = process.env.STORAGE_CAPACITY_TEST === '1';

export const capacitySources = {
  workspaces: Array.from({ length: dimensions.fixtureWorkspaces }, (_, index) => `127.0.0.${index + 2}`),
  control: ['127.0.0.102', '127.0.0.103', '127.0.0.104', '127.0.0.105'],
};

export function createCapacityTransport() {
  const agent = new Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 1 });
  return {
    close: () => agent.destroy(),
    async request({ api, path, method = 'GET', headers, body, localAddress }) {
      const response = await new Promise((resolve, reject) => {
        const request = httpRequest(
          `${api}${path}`,
          { method, headers, localAddress, agent, signal: AbortSignal.timeout(15000) },
          resolve,
        );
        request.once('error', reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
      });
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      return {
        status: response.statusCode,
        data: JSON.parse(Buffer.concat(chunks).toString()),
        headers: response.headers,
      };
    },
  };
}

export async function verifyCapacitySources(transport, addresses = Object.values(capacitySources).flat()) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ remoteAddress: request.socket.remoteAddress }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const api = `http://127.0.0.1:${server.address().port}`;
    for (const localAddress of addresses) {
      const result = await transport.request({ api, path: '/', localAddress });
      assert.equal(result.data.remoteAddress, localAddress, 'Capacity traffic must use actual socket source addresses');
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}

export async function installCapacityApplicationAccess(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await grantApplicationAccess(client, 'isolated-v1');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test(
  'real HTTP replicas and Temporal workers at 100-workspace capacity',
  { skip: !enabled, timeout: 1200000 },
  async t => {
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
      '',
      'Commit source before capacity proof',
    );
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const report = {
      head,
      dimensions,
      budgets,
      environment: {
        node: process.version,
        parallelism: availableParallelism(),
        memoryGiB: Math.round(totalmem() / 2 ** 30),
      },
      phases: {},
      fixture: {},
      flow: { httpWorkspacesReady: 0 },
      errors: {},
      blockers: [],
      checks: {},
      cleanup: {},
    };
    process.stdout.write(`CAPACITY_PLAN ${JSON.stringify({ dimensions, budgets })}\n`);
    const transport = createCapacityTransport();
    t.after(() => transport.close());
    try {
      await verifyCapacitySources(transport);
    } catch (error) {
      report.blockers.push({ stage: 'http-source-preflight', code: error.code, message: error.message });
      report.passed = false;
      if (process.env.STORAGE_CAPACITY_ARTIFACTS) {
        mkdirSync(process.env.STORAGE_CAPACITY_ARTIFACTS, { recursive: true });
        writeFileSync(`${process.env.STORAGE_CAPACITY_ARTIFACTS}/result.json`, JSON.stringify(report, null, 2));
      }
      throw error;
    }
    report.fixture.httpSources = {
      transport: 'node:http localAddress, direct socket peers, no forwarded headers',
      workspaces: capacitySources.workspaces,
      control: capacitySources.control,
      assignment:
        'One fixed source per fixture workspace; control requests round-robin across four separate sources. Two authenticated users.',
    };
    const priorEnv = { ...process.env };
    const token = randomUUID().replaceAll('-', '');
    const database = `capacity_${token}`;
    const owner = `cap_owner_${token}`;
    const identity = 'tulipfarm';
    const password = randomBytes(32).toString('hex');
    const container = `capacity-pg-${token}`;
    const native = process.env.STORAGE_CAPACITY_POSTGRES_BIN ? await startNativePostgres() : undefined;
    if (native) t.after(() => native.close());
    report.environment.postgresTransport = native?.metadata ?? { transport: 'docker-published-port', version: '18.3' };
    if (!native)
      execFileSync(
        'docker',
        [
          'run',
          '--detach',
          '--rm',
          '--name',
          container,
          '--publish',
          '127.0.0.1::5432',
          '--env',
          'POSTGRES_PASSWORD=local-postgres',
          'postgres:18.3',
          '-c',
          'max_connections=120',
          '-c',
          'log_line_prefix=%m [%p] %q%u@%d/%a %e ',
          '-c',
          'log_error_verbosity=verbose',
          '-c',
          'log_min_error_statement=panic',
          '-c',
          'log_disconnections=on',
        ],
        { stdio: 'pipe' },
      );
    const port =
      native?.port ??
      execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
    const adminURL = `postgresql://postgres:local-postgres@127.0.0.1:${port}/postgres`;
    const url = role => `postgresql://${role}:${password}@127.0.0.1:${port}/${database}`;
    const admin = new Pool({ connectionString: adminURL, max: 1, connectionTimeoutMillis: 5000 });
    const ownerPool = new Pool({
      connectionString: url(owner),
      max: 2,
      options: '-c search_path=app',
      connectionTimeoutMillis: 5000,
    });
    const identityPool = new Pool({
      connectionString: url(identity),
      max: 1,
      options: '-c search_path=app',
      connectionTimeoutMillis: 5000,
    });
    const registries = [];
    const workspaces = [];
    const processes = [];
    const resources = [];
    const users = [];
    const roleLabels = new Map([
      [owner, 'provisioning'],
      [identity, 'identity'],
    ]);
    let storage;
    let maintenance;
    let temporal;
    let phase = 'setup';
    let sampling = false;
    let sampler;
    let stopTraffic = false;
    let traffic;
    let failure;
    let diagnostic;
    let mixedEpoch;
    let stage = 'preflight';
    let controlRequest = 0;
    const knownSecrets = [password];
    const artifactDirectory = process.env.STORAGE_CAPACITY_ARTIFACTS;
    if (artifactDirectory) mkdirSync(artifactDirectory, { recursive: true });
    const heartbeat = setInterval(
      () => process.stdout.write(`CAPACITY_PROGRESS ${JSON.stringify({ stage, workspaces: workspaces.length })}\n`),
      15000,
    );
    const errorCount = key => {
      report.errors[key] = (report.errors[key] ?? 0) + 1;
    };
    const phaseStats = () =>
      (report.phases[phase] ??= {
        connectionSamples: 0,
        peakConnections: 0,
        peakClusterConnections: 0,
        peakByCapability: {},
        peakByRole: {},
        peakByProcess: {},
        lockWaitSamples: 0,
        maxWaitingConnections: 0,
        maxLockWaitAgeMs: 0,
        sampleGapMaxMs: 0,
        http: {},
        recordLatencies: [],
        deniedChecks: 0,
        unauthorizedResults: 0,
      });
    const sanitizeCode = error =>
      /^[A-Z0-9_]{2,40}$/.test(error?.code ?? '')
        ? error.code
        : error?.name === 'AssertionError'
          ? 'ASSERTION'
          : 'FAILED';
    function redact(text) {
      let message = text;
      for (const secret of knownSecrets) if (secret) message = message.replaceAll(secret, '[redacted]');
      message = message
        .replaceAll(/postgres(?:ql)?:\/\/\S+/g, '[database-url]')
        .replaceAll(/[a-f0-9]{32,}/g, '[id]')
        .replaceAll(/synthetic-[\w-]+/g, '[synthetic-value]');
      return message;
    }
    function diagnosticError(error) {
      return {
        code: sanitizeCode(error),
        name: error?.name,
        message: redact(error instanceof Error ? error.message : 'unknown').slice(0, 300),
        stack: redact(error?.stack ?? ''),
      };
    }
    function captureDiagnostics(label) {
      if (native) {
        const snapshot = {
          ...native.capture(),
          phase,
          children: processes.map(child => ({
            label: child.capacityLabel,
            pid: child.pid,
            exitCode: child.exitCode,
            signalCode: child.signalCode,
          })),
        };
        (report.environment.snapshots ??= {})[label] = snapshot;
        if (artifactDirectory) {
          writeFileSync(`${artifactDirectory}/${label}-postgres.log`, redact(native.logs()));
          writeFileSync(`${artifactDirectory}/${label}-health.json`, JSON.stringify(snapshot, null, 2));
          for (const child of processes)
            writeFileSync(`${artifactDirectory}/${label}-${child.capacityLabel}.log`, redact(child.capacityLogs));
        }
        return;
      }
      const inspect = JSON.parse(
        execFileSync('docker', ['inspect', '--format', '{{json .State}}', container], { encoding: 'utf8' }),
      );
      const restartCount = Number(
        execFileSync('docker', ['inspect', '--format', '{{.RestartCount}}', container], { encoding: 'utf8' }),
      );
      const top = spawnSync('docker', ['top', container, '-eo', 'pid,ppid,stat,comm'], { encoding: 'utf8' });
      const snapshot = {
        at: new Date().toISOString(),
        phase,
        inspect,
        restartCount,
        postgresProcesses: top.stdout,
        children: processes.map(child => ({
          label: child.capacityLabel,
          pid: child.pid,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
        })),
      };
      (report.environment.snapshots ??= {})[label] = snapshot;
      if (artifactDirectory) {
        const stderrLogs = spawnSync('docker', ['logs', container], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
        assert.equal(stderrLogs.status, 0);
        writeFileSync(`${artifactDirectory}/${label}-postgres.log`, redact(stderrLogs.stdout + stderrLogs.stderr));
        writeFileSync(`${artifactDirectory}/${label}-health.json`, JSON.stringify(snapshot, null, 2));
        for (const child of processes)
          writeFileSync(`${artifactDirectory}/${label}-${child.capacityLabel}.log`, redact(child.capacityLogs));
        const ip = execFileSync(
          'docker',
          ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container],
          { encoding: 'utf8' },
        ).trim();
        assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
        const network = spawnSync(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'host',
            '--entrypoint',
            'sh',
            'postgres:18.3',
            '-c',
            `cat /proc/net/sockstat; cat /proc/sys/net/ipv4/ip_local_port_range; cat /proc/net/tcp; PGCONNECT_TIMEOUT=3 psql -U postgres -h ${ip} -c 'SELECT 1'`,
          ],
          { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 15000 },
        );
        writeFileSync(`${artifactDirectory}/${label}-vm-network.txt`, network.stdout + network.stderr);
        const inside = spawnSync(
          'docker',
          [
            'exec',
            container,
            'psql',
            '-U',
            'postgres',
            '-h',
            '127.0.0.1',
            '-c',
            'SELECT pg_postmaster_start_time(), count(*) FROM pg_stat_activity; SELECT extname, extversion FROM pg_extension',
          ],
          { encoding: 'utf8', timeout: 5000 },
        );
        writeFileSync(`${artifactDirectory}/${label}-inside-postgres.txt`, inside.stdout + inside.stderr);
      }
    }
    function labelWorkspace(workspace) {
      const names = workspaceNames(workspace.id);
      for (const capability of ['runtime', 'migration', 'confirmation', 'customOwner'])
        roleLabels.set(names[capability], capability);
    }
    function healthy() {
      for (const child of processes)
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`capacity-child-exited:${child.capacityLabel}`);
    }
    async function waitFor(read, accepts, name, timeout = budgets.automaticMigrationDeadlineMs) {
      const until = performance.now() + timeout;
      while (performance.now() < until) {
        healthy();
        const value = await read();
        if (accepts(value)) return value;
        await setTimeout(150);
      }
      throw new Error(`capacity-timeout:${name}`);
    }
    function startProcess(entry, env, label) {
      const child = spawn(process.execPath, [fileURLToPath(new URL(entry, import.meta.url))], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...env, PGAPPNAME: label },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.capacityLabel = label;
      child.capacityLogs = '';
      for (const output of [child.stdout, child.stderr])
        output.on('data', data => {
          const text = data.toString();
          if (knownSecrets.some(secret => secret && text.includes(secret))) errorCount('secret-in-child-output');
          child.capacityLogs = (child.capacityLogs + text).slice(-100000);
        });
      child.on('error', () => errorCount(`spawn-${label}`));
      processes.push(child);
      return child;
    }
    async function http(
      api,
      method,
      path,
      user,
      body,
      category = 'control',
      localAddress = capacitySources.control[controlRequest++ % capacitySources.control.length],
    ) {
      const stats = phaseStats();
      const started = performance.now();
      let status = 0;
      try {
        const response = await transport.request({
          api,
          path,
          method,
          localAddress,
          body,
          headers: { ...user?.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        });
        status = response.status;
        return { status, data: response.data };
      } finally {
        const key = `${category}:${method}:${status}`;
        stats.http[key] = (stats.http[key] ?? 0) + 1;
        if (category === 'record') stats.recordLatencies.push(performance.now() - started);
      }
    }
    async function request(api, method, path, user, body, expected = 200) {
      const result = await http(api, method, path, user, body);
      assert.equal(result.status, expected, `HTTP ${method} expected ${expected}, received ${result.status}`);
      return result.data;
    }
    async function seedTables(workspace, index) {
      const names = workspaceNames(workspace.id);
      const row = (
        await ownerPool.query(
          'SELECT generation, migration_credential FROM app.workspace_storage WHERE workspace_id = $1',
          [workspace.id],
        )
      ).rows[0];
      const connectionString = decryptCredential(
        row.migration_credential,
        { workspaceId: workspace.id, generation: row.generation, capability: 'migration' },
        credentialKeyring('migration'),
      );
      const team = randomUUID();
      await ownerPool.query(`INSERT INTO "${names.schema}".tf_teams (id, name) VALUES ($1, 'Capacity fixture')`, [
        team,
      ]);
      const runtime = workspaceRuntime(identityPool);
      try {
        for (let tableIndex = 0; tableIndex < dimensions.tablesPerWorkspace; tableIndex++) {
          const fields = [textField('Name'), textField('Note')];
          const created = await createTableWithRows({
            db: { login: () => connectionString },
            workspace: { id: workspace.id, userId: users[index % 2].id, names },
            runtime,
            definition: tableDefinition({ owningTeamId: team, label: 'Capacity fixture', fields }),
            records: Array.from({ length: dimensions.recordsPerTable }, (_, i) => ({
              values: textValues(fields[0], `synthetic-${index}-${tableIndex}-${i}`),
            })),
          });
          resources.push({
            workspace,
            definition: created.definition,
            revision: created.revision,
            tableName: created.generation.physical_table,
            user: users[index % 2],
            localAddress: capacitySources.workspaces[index],
          });
        }
      } finally {
        await runtime.close();
      }
    }
    async function runTraffic(apis) {
      await Promise.all(
        apis.flatMap((api, replica) =>
          Array.from({ length: dimensions.trafficLanesPerApi }, async (_, lane) => {
            let iteration = 0;
            while (!stopTraffic) {
              const item = resources[(iteration * 8 + replica * 4 + lane) % resources.length];
              const base = `/v1/workspaces/${item.workspace.id}/tables/${item.definition.id}`;
              const listPath = `${base}/rows?revision=${item.revision}&limit=1`;
              try {
                const result = await http(api, 'GET', listPath, item.user, undefined, 'record', item.localAddress);
                if (result.status !== 200) {
                  errorCount(`record-http-${result.status}`);
                  const code = /^[a-z-]{1,60}$/.test(result.data?.error ?? '') ? result.data.error : 'unclassified';
                  errorCount(`record-error-${code}`);
                  const second = Math.floor((performance.now() - mixedEpoch) / 1000);
                  const buckets = (report.flow.errorSeconds ??= {});
                  buckets[second] = (buckets[second] ?? 0) + 1;
                  if (!diagnostic)
                    diagnostic = (async () => {
                      await cleanupStep('first-error-diagnostics', async () => {
                        captureDiagnostics('first-http-error');
                      });
                    })();
                } else if (
                  !Array.isArray(result.data) ||
                  typeof result.data[0]?.values?.[item.definition.fields[0].id]?.value !== 'string'
                )
                  errorCount('record-shape');
                if (iteration % 20 === 0) {
                  const other = users[(users.indexOf(item.user) + 1) % 2];
                  const denied = await http(api, 'GET', listPath, other, undefined, 'denied', item.localAddress);
                  phaseStats().deniedChecks++;
                  if ((denied.status >= 200 && denied.status < 300) || Array.isArray(denied.data)) {
                    phaseStats().unauthorizedResults++;
                    errorCount('unauthorized-result');
                  } else if (denied.status !== 404 || denied.data.error !== 'proposal-unavailable')
                    errorCount(`denial-probe-http-${denied.status}`);
                }
              } catch {
                errorCount('traffic-request-failed');
              }
              iteration++;
              await setTimeout(dimensions.lanePauseMs);
            }
          }),
        ),
      );
    }
    async function cleanupStep(name, operation) {
      try {
        await operation();
        report.cleanup[name] = 'passed';
      } catch (error) {
        report.cleanup[name] = sanitizeCode(error);
        failure ??= new Error(`cleanup-${name}`);
      }
    }
    try {
      assert.notEqual(process.env.NODE_ENV, 'production', 'Capacity test requires local environment');
      assert.equal(process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233', '127.0.0.1:7233');
      assert.equal(process.env.TEMPORAL_NAMESPACE ?? 'default', 'default');
      assert.equal(process.env.R2_SOUL_BUCKET ?? 'tulipfarm-cloud-soul-local', 'tulipfarm-cloud-soul-local');
      await waitFor(
        async () => {
          try {
            await admin.query('SELECT 1');
            return true;
          } catch {
            return false;
          }
        },
        Boolean,
        'postgres-start',
        15000,
      );
      report.environment.postgres = (await admin.query('SHOW server_version')).rows[0].server_version;
      report.environment.maxConnections = Number((await admin.query('SHOW max_connections')).rows[0].max_connections);
      await admin.query(`CREATE ROLE ${escapeIdentifier(owner)} LOGIN CREATEROLE PASSWORD ${escapeLiteral(password)}`);
      await admin.query(
        `CREATE ROLE ${escapeIdentifier(identity)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${escapeLiteral(password)}`,
      );
      await admin.query(`CREATE DATABASE ${escapeIdentifier(database)} OWNER ${escapeIdentifier(owner)}`);
      await provisionTestPgvector(admin, database, owner);
      await admin.query(`REVOKE ALL ON DATABASE ${escapeIdentifier(database)} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${escapeIdentifier(identity)}`);
      const globalMigrations = await readMigrations(
        fileURLToPath(new URL('../../database/migrations', import.meta.url)),
      );
      for (const migration of globalMigrations) await ownerPool.query(migration.sql);
      await installCapacityApplicationAccess(ownerPool);
      report.fixture.globalStream = globalMigrations.map(({ name, checksum }) => ({ name, checksum }));
      const registryURLs = {};
      for (const capability of ['authoring', 'confirmation', 'migration']) {
        const role = `cap_${capability}_${token}`;
        registries.push(role);
        roleLabels.set(role, `${capability}-registry`);
        const client = await ownerPool.connect();
        try {
          await provisionTableRegistry(client, { capability, role, password });
        } finally {
          client.release();
        }
        registryURLs[capability] = url(role);
      }
      const emailRole = `cap_email_${token}`;
      registries.push(emailRole);
      roleLabels.set(emailRole, 'email-delivery');
      await admin.query(
        `CREATE ROLE ${escapeIdentifier(emailRole)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`,
      );
      await ownerPool.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${escapeIdentifier(emailRole)};
      GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(emailRole)};
      GRANT SELECT, UPDATE ON app.email_deliveries TO ${escapeIdentifier(emailRole)}`);
      for (const key of Object.keys(process.env))
        if (
          /^(WORKSPACE_|BETTER_AUTH_|GOOGLE_|EMAIL_DELIVERY_|INTEGRATION_|MODEL_|ACS_|SMTP_|EMAIL_PROVIDER$|TURNSTILE_|DATABASE_URL$)/.test(
            key,
          )
        )
          delete process.env[key];
      Object.assign(process.env, {
        NODE_ENV: 'test',
        WEB_ORIGIN: 'http://localhost:5173',
        BETTER_AUTH_URL: 'http://localhost:3001',
        BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
        DATABASE_URL: url(identity),
        WORKSPACE_STORAGE_CAPABILITY: 'isolated-v1',
        API_PROXY_MODE: 'direct',
        WORKSPACE_RUNTIME_REPLICAS: '4',
        WORKSPACE_DATABASE_CONNECTION_BUDGET: '120',
        WORKSPACE_PROVISIONING_DATABASE_URL: url(owner),
        WORKSPACE_DATABASE_ENDPOINT: `postgresql://127.0.0.1:${port}/${database}`,
        WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL: registryURLs.migration,
        WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL: registryURLs.confirmation,
        TEMPORAL_TASK_QUEUE: `capacity-authoring-${token}`,
        TEMPORAL_STORAGE_TASK_QUEUE: `capacity-maintenance-${token}`,
      });
      process.env.EMAIL_DELIVERY_KEY = randomBytes(32).toString('hex');
      process.env.EMAIL_DELIVERY_KEY_ID = 'capacity-email-v1';
      process.env.INTEGRATION_CREDENTIAL_KEY = randomBytes(32).toString('hex');
      process.env.INTEGRATION_CREDENTIAL_KEY_ID = 'capacity-connection-v1';
      knownSecrets.push(process.env.EMAIL_DELIVERY_KEY, process.env.INTEGRATION_CREDENTIAL_KEY);
      if (!process.env.R2_SOUL_READ_ACCESS_KEY_ID || !process.env.R2_SOUL_READ_SECRET_ACCESS_KEY) {
        assert.equal(
          process.env.STORAGE_CAPACITY_LOCAL_WRITER_FOR_READ,
          '1',
          'Explicit local-only Soul reader fallback required',
        );
        process.env.R2_SOUL_READ_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
        process.env.R2_SOUL_READ_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
        report.environment.soulReader = 'explicit-local-writer-fallback; not a production reader qualification';
      } else report.environment.soulReader = 'separate-reader';
      for (const capability of ['RUNTIME', 'MIGRATION', 'CONFIRMATION']) {
        process.env[`WORKSPACE_${capability}_KEY`] = randomBytes(32).toString('hex');
        process.env[`WORKSPACE_${capability}_KEY_ID`] = 'capacity-v1';
        knownSecrets.push(process.env[`WORKSPACE_${capability}_KEY`]);
      }
      knownSecrets.push(
        process.env.BETTER_AUTH_SECRET,
        process.env.R2_ACCESS_KEY_ID,
        process.env.R2_SECRET_ACCESS_KEY,
        process.env.R2_SOUL_READ_ACCESS_KEY_ID,
        process.env.R2_SOUL_READ_SECRET_ACCESS_KEY,
      );
      const stream = await workspaceTableMigrations();
      report.fixture.commonStream = stream.map(({ name, checksum }) => ({ name, checksum }));
      report.fixture.rollout =
        'Replay the exact current stream and add a nullable catalog column with a separate transactional rehearsal receipt';
      report.fixture.additiveDdlConcurrency = 2;
      await ownerPool.query(
        'CREATE SCHEMA IF NOT EXISTS database_management; REVOKE ALL ON SCHEMA database_management FROM PUBLIC',
      );
      await ownerPool.query(
        'CREATE TABLE database_management.capacity_additive_receipts (workspace_id uuid PRIMARY KEY, column_name text NOT NULL)',
      );
      report.fixture.commonMigration = stream.at(-1).name;
      stage = 'R2-preflight';
      storage = soulStorageConfig();
      await storage.client.send(
        new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: `capacity-preflight/${token}/`, MaxKeys: 1 }),
      );
      stage = 'Temporal-preflight';
      temporal = createTemporalClient();
      await temporal.connection.withDeadline(Date.now() + 10000, () =>
        temporal.connection.workflowService.getSystemInfo({}),
      );
      for (let index = 0; index < dimensions.httpUsers; index++) {
        let link;
        const auth = createAuth(
          identityPool,
          async data => {
            link = data.url;
          },
          async () => {},
        );
        await auth.api.signInMagicLink({
          headers: new Headers({ origin: process.env.WEB_ORIGIN }),
          body: { email: `${randomUUID()}@example.com`, name: 'Capacity synthetic user' },
        });
        const result = await auth.handler(new Request(link));
        const cookie = result.headers
          .getSetCookie()
          .map(value => value.split(';')[0])
          .join('; ');
        assert.ok(cookie);
        knownSecrets.push(cookie);
        const headers = { cookie, origin: process.env.WEB_ORIGIN };
        const session = await auth.api.getSession({ headers: new Headers(headers) });
        assert.ok(session);
        users.push({ headers, id: session.user.id });
      }
      sampling = true;
      sampler = (async () => {
        let previous = performance.now();
        while (sampling) {
          const stats = phaseStats();
          const now = performance.now();
          stats.sampleGapMaxMs = Math.max(stats.sampleGapMaxMs, now - previous);
          previous = now;
          const rows = (
            await admin.query(`SELECT datname, usename, application_name, wait_event_type,
          CASE WHEN wait_event_type = 'Lock' THEN EXTRACT(epoch FROM clock_timestamp() - query_start) * 1000 ELSE 0 END AS wait_age
          FROM pg_stat_activity WHERE backend_type = 'client backend'`)
          ).rows;
          const own = rows.filter(row => row.datname === database);
          stats.connectionSamples++;
          stats.peakConnections = Math.max(stats.peakConnections, own.length);
          stats.peakClusterConnections = Math.max(stats.peakClusterConnections, rows.length);
          for (const [field, peaks, classify] of [
            ['usename', stats.peakByCapability, value => roleLabels.get(value) ?? 'unclassified'],
            ['usename', stats.peakByRole, value => value],
            ['application_name', stats.peakByProcess, value => value || 'fixture-or-rollout'],
          ]) {
            const counts = {};
            for (const row of own) {
              const key = classify(row[field]);
              counts[key] = (counts[key] ?? 0) + 1;
            }
            for (const [key, count] of Object.entries(counts)) peaks[key] = Math.max(peaks[key] ?? 0, count);
          }
          const waits = own.filter(row => row.wait_event_type === 'Lock');
          stats.lockWaitSamples += waits.length;
          stats.maxWaitingConnections = Math.max(stats.maxWaitingConnections, waits.length);
          for (const row of waits) stats.maxLockWaitAgeMs = Math.max(stats.maxLockWaitAgeMs, Number(row.wait_age));
          await setTimeout(dimensions.sampleIntervalMs);
        }
      })().catch(() => {
        errorCount('sampler-failed');
      });
      stage = 'fixture';
      phase = 'fixture';
      const fixtureStarted = performance.now();
      maintenance = createWorkspaceMaintenance({ migrations: stream });
      for (let index = 0; index < dimensions.fixtureWorkspaces; index++) {
        const workspace = (
          await ownerPool.query(
            `INSERT INTO app.workspaces (request_id, created_by, name, slug) VALUES ($1, $2, 'Capacity fixture', $3) RETURNING id, slug`,
            [randomUUID(), users[index % 2].id, `capacity-fixture-${index}`],
          )
        ).rows[0];
        workspaces.push(workspace);
        labelWorkspace(workspace);
        await ownerPool.query('INSERT INTO app.workspace_storage (workspace_id) VALUES ($1)', [workspace.id]);
        await maintenance.initializeWorkspaceStorage(workspace.id);
        await seedTables(workspace, index);
      }
      await maintenance.close();
      maintenance = undefined;
      report.fixture.provisioningMs = performance.now() - fixtureStarted;
      report.fixture.workspaces = Number(
        (await ownerPool.query("SELECT count(*) FROM app.workspace_storage WHERE stage = 'ready'")).rows[0].count,
      );
      report.fixture.tableTables = resources.length;
      report.fixture.recordRows = 0;
      for (const item of resources)
        report.fixture.recordRows += Number(
          (
            await ownerPool.query(
              `SELECT count(*) FROM "${workspaceNames(item.workspace.id).schema}"."${item.tableName}"`,
            )
          ).rows[0].count,
        );
      assert.equal(report.fixture.workspaces, 100);
      assert.equal(report.fixture.tableTables, 200);
      assert.equal(report.fixture.recordRows, 20000);
      process.stdout.write(`CAPACITY_FIXTURE ${JSON.stringify(report.fixture)}\n`);
      const apiEnv = { ...process.env, HOST: '127.0.0.1', PORT: '0' };
      for (const key of [
        'WORKSPACE_PROVISIONING_DATABASE_URL',
        'WORKSPACE_MIGRATION_KEY',
        'WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
      ])
        delete apiEnv[key];
      const ordinaryEnv = {
        ...process.env,
        WORKSPACE_AUTHORING_DATABASE_URL: registryURLs.authoring,
        EMAIL_DELIVERY_DATABASE_URL: url(emailRole),
      };
      for (const key of [
        'DATABASE_URL',
        'WORKSPACE_PROVISIONING_DATABASE_URL',
        'WORKSPACE_MIGRATION_KEY',
        'WORKSPACE_CONFIRMATION_KEY',
        'WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL',
        'WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL',
      ])
        delete ordinaryEnv[key];
      const maintenanceEnv = { ...process.env };
      delete maintenanceEnv.DATABASE_URL;
      delete maintenanceEnv.WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL;
      for (const key of Object.keys(maintenanceEnv))
        if (/^(EMAIL_DELIVERY_|INTEGRATION_|BETTER_AUTH_|R2_SOUL_READ_)/.test(key)) delete maintenanceEnv[key];
      for (const key of Object.keys(ordinaryEnv))
        if (/^(BETTER_AUTH_|R2_SOUL_READ_)/.test(key)) delete ordinaryEnv[key];
      assert.equal(maintenanceEnv.EMAIL_DELIVERY_KEY, undefined);
      assert.equal(maintenanceEnv.INTEGRATION_CREDENTIAL_KEY, undefined);
      assert.equal(apiEnv.EMAIL_DELIVERY_DATABASE_URL, undefined);
      stage = 'process-start';
      phase = 'startup';
      startProcess('../src/storage-worker.ts', maintenanceEnv, 'capacity-maintenance');
      for (let index = 0; index < 2; index++) startProcess('../src/worker.ts', ordinaryEnv, `capacity-worker-${index}`);
      const apis = [];
      for (let index = 0; index < 2; index++) {
        const child = startProcess('../../api/src/server.ts', apiEnv, `capacity-api-${index}`);
        const address = await waitFor(
          async () => /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(child.capacityLogs)?.[1],
          Boolean,
          'api-listen',
        );
        apis.push(address);
        await request(address, 'GET', '/v1/health/live');
        const session = await request(address, 'GET', '/v1/auth/get-session', users[index]);
        assert.equal(session.user.id, users[index].id);
      }
      await waitFor(
        async () =>
          processes
            .filter(child => child.capacityLabel.includes('worker') || child.capacityLabel.includes('maintenance'))
            .every(child => child.capacityLogs.includes('RUNNING')),
        Boolean,
        'worker-polling',
      );
      report.flow.processes = processes.map(child => ({ role: child.capacityLabel, pid: child.pid }));
      stage = 'baseline';
      phase = 'baseline';
      traffic = runTraffic(apis);
      await setTimeout(dimensions.baselineMs);
      stage = 'mixed';
      phase = 'mixed';
      const mixedStarted = performance.now();
      mixedEpoch = mixedStarted;
      let rolloutPublished;
      const published = new Promise(resolve => {
        rolloutPublished = resolve;
      });
      let rolloutActive = true;
      const rolloutStarted = performance.now();
      const rollout = rolloutCommonMigrations({
        connectionString: url(owner),
        migrations: stream,
        concurrency: dimensions.rolloutConcurrency,
        listWorkspaceIds: async () => {
          rolloutPublished();
          return (
            await ownerPool.query("SELECT workspace_id FROM app.workspace_storage WHERE stage = 'ready'")
          ).rows.map(row => row.workspace_id);
        },
        afterWorkspace: async result => {
          assert.equal(result.status, 'applied');
          const client = await ownerPool.connect();
          try {
            await client.query('BEGIN');
            await client.query("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s'");
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 734129))', [result.workspaceId]);
            await client.query(
              `LOCK TABLE ${escapeIdentifier(workspaceNames(result.workspaceId).schema)}.tf_common_migrations IN ACCESS EXCLUSIVE MODE`,
            );
            await client.query(
              `SELECT id FROM ${escapeIdentifier(workspaceNames(result.workspaceId).schema)}.tf_authorization_lock WHERE id=1 FOR UPDATE`,
            );
            await client.query(
              `ALTER TABLE ${escapeIdentifier(workspaceNames(result.workspaceId).schema)}.tf_table_catalog ADD COLUMN capacity_rehearsal integer`,
            );
            await client.query(
              "INSERT INTO database_management.capacity_additive_receipts VALUES ($1, 'capacity_rehearsal')",
              [result.workspaceId],
            );
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
          await setTimeout(dimensions.rolloutPausePerWorkspaceMs);
        },
      }).then(result => {
        rolloutActive = false;
        report.flow.rolloutMs = performance.now() - rolloutStarted;
        report.flow.rolloutResults = result.results.reduce((counts, item) => {
          counts[item.status] = (counts[item.status] ?? 0) + 1;
          return counts;
        }, {});
        return result;
      });
      const churn = (async () => {
        await published;
        await Promise.all(
          apis.map(async (api, index) => {
            const user = users[index];
            const started = performance.now();
            assert.ok(rolloutActive);
            const workspace = await request(
              api,
              'POST',
              '/v1/workspaces',
              user,
              {
                requestId: randomUUID(),
                name: 'Capacity HTTP',
                slug: `capacity-http-${index}`,
                challengeToken: 'XXXX.DUMMY.TOKEN.XXXX',
              },
              202,
            );
            workspaces.push(workspace);
            labelWorkspace(workspace);
            await waitFor(
              async () => (await http(api, 'GET', `/v1/workspaces/${workspace.slug}`, user)).status,
              status => status === 200,
              'http-workspace-ready',
            );
            report.flow.httpWorkspacesReady++;
            report.flow[`workspace${index}ReadyMs`] = performance.now() - started;
            report.flow[`workspace${index}ReadyDuringRollout`] = rolloutActive;
          }),
        );
      })();
      const mixedResults = await Promise.allSettled([rollout, churn, setTimeout(dimensions.mixedMinimumMs)]);
      report.flow.mixedMs = performance.now() - mixedStarted;
      for (const result of mixedResults)
        if (result.status === 'rejected') {
          errorCount('mixed-operation-failed');
          report.flow.mixedFailure = diagnosticError(result.reason);
          failure ??= result.reason;
        }
      stopTraffic = true;
      await traffic;
      traffic = undefined;
      healthy();
      stage = 'verification';
      phase = 'verification';
      let failedGrants = 0;
      let commonReceipts = 0;
      for (const workspace of workspaces) {
        try {
          await verifyWorkspaceIsolation(ownerPool, workspace.id);
        } catch {
          failedGrants++;
        }
        const names = workspaceNames(workspace.id);
        assert.deepEqual(
          (await ownerPool.query(`SELECT name, checksum FROM "${names.schema}".tf_common_migrations ORDER BY name`))
            .rows,
          stream.map(({ name, checksum }) => ({ name, checksum })),
        );
        assert.deepEqual(
          (
            await ownerPool.query(
              `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='tf_table_catalog' AND column_name='capacity_rehearsal'`,
              [names.schema],
            )
          ).rows,
          [{ data_type: 'integer', is_nullable: 'YES' }],
        );
        commonReceipts += Number(
          (
            await ownerPool.query(`SELECT count(*) FROM "${names.schema}".tf_common_migrations WHERE name = $1`, [
              stream.at(-1).name,
            ])
          ).rows[0].count,
        );
      }
      for (const item of resources) {
        const names = workspaceNames(item.workspace.id);
        const result = (
          await ownerPool.query(
            `SELECT has_table_privilege($1, $2, 'SELECT') OR has_table_privilege($1, $2, 'INSERT')
        OR has_table_privilege($1, $2, 'UPDATE') OR has_table_privilege($1, $2, 'DELETE') AS allowed`,
            [names.runtime, `"${names.schema}"."${item.tableName}"`],
          )
        ).rows[0];
        if (result.allowed) failedGrants++;
      }
      report.checks.failedGrantChecks = failedGrants;
      report.checks.workspacesWithLatestCommonReceipt = commonReceipts;
      report.checks.additiveRolloutReceipts = Number(
        (await ownerPool.query('SELECT count(*) FROM database_management.capacity_additive_receipts')).rows[0].count,
      );
      assert.equal(report.checks.additiveRolloutReceipts, 102);
      report.checks.workspaceDiscoveryAt102 = (await http(apis[0], 'GET', '/v1/workspaces', users[0])).status;
      report.checks.realHttpFlows = report.flow.httpWorkspacesReady === 2;
      report.checks.commonRollout = commonReceipts === 102 && report.flow.rolloutResults?.applied === 102;
      report.checks.overlap = report.flow.workspace0ReadyDuringRollout && report.flow.workspace1ReadyDuringRollout;
      assert.ok(report.checks.realHttpFlows);
      assert.ok(report.checks.commonRollout);
      assert.equal(failedGrants, 0);
    } catch (error) {
      failure ??= error;
      report.blockers.push({ stage, ...diagnosticError(error) });
    } finally {
      clearInterval(heartbeat);
      stopTraffic = true;
      await traffic;
      await diagnostic;
      sampling = false;
      await sampler;
      await cleanupStep('pre-cleanup-diagnostics', async () => {
        captureDiagnostics('pre-cleanup');
      });
      for (const child of processes)
        await cleanupStep(child.capacityLabel, async () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          await Promise.race([exited, setTimeout(15000)]);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await exited;
          }
          child.capacityLogs = '';
        });
      await cleanupStep('maintenance-client', async () => {
        await maintenance?.close();
      });
      await cleanupStep('temporal', async () => {
        await temporal?.connection.close();
      });
      if (storage)
        await cleanupStep('R2-own-prefixes', async () => {
          for (const workspace of workspaces) {
            let continuation;
            do {
              const page = await storage.client.send(
                new ListObjectsV2Command({
                  Bucket: storage.bucket,
                  Prefix: `workspaces/${workspace.id}/soul/`,
                  ContinuationToken: continuation,
                }),
              );
              if (page.Contents?.length) {
                const deleted = await storage.client.send(
                  new DeleteObjectsCommand({
                    Bucket: storage.bucket,
                    Delete: { Objects: page.Contents.map(({ Key }) => ({ Key })) },
                  }),
                );
                assert.equal(deleted.Errors?.length ?? 0, 0);
              }
              continuation = page.NextContinuationToken;
            } while (continuation);
          }
          storage.client.destroy();
        });
      await cleanupStep('pools', async () => {
        await ownerPool.end();
        await identityPool.end();
      });
      await cleanupStep('database', async () => {
        await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(database)} WITH (FORCE)`);
      });
      await cleanupStep('roles', async () => {
        for (const workspace of workspaces)
          for (const capability of ['runtime', 'migration', 'confirmation', 'customOwner'])
            await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(workspaceNames(workspace.id)[capability])}`);
        for (const role of [...registries, identity, owner])
          await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
        assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount, 0);
        assert.equal(
          (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = ANY($1::text[])', [[...roleLabels.keys()]]))
            .rowCount,
          0,
        );
      });
      await admin.end();
      await cleanupStep('postgres-diagnostics', async () => {
        const logs = native
          ? native.logs()
          : (() => {
              const result = spawnSync('docker', ['logs', container], {
                encoding: 'utf8',
                maxBuffer: 10 * 1024 * 1024,
              });
              return result.stdout + result.stderr;
            })();
        report.environment.postgresRestarts = (
          logs.match(/database system is ready to accept integrations/g) ?? []
        ).length;
        report.environment.postgresDiagnostics = [
          ...new Set(
            logs
              .split('\n')
              .filter(line =>
                /FATAL:|PANIC:|terminated by signal|reinitializing|out of memory|could not fork|terminating integration|segmentation|No space/.test(
                  line,
                ),
              )
              .map(line => diagnosticError(new Error(line)).message),
          ),
        ].slice(0, 30);
      });
      await cleanupStep(native ? 'postgres-native' : 'postgres-container', async () => {
        if (native) await native.close();
        else execFileSync('docker', ['stop', container], { stdio: 'pipe', timeout: 20000 });
      });
      for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
      Object.assign(process.env, priorEnv);
      for (const stats of Object.values(report.phases)) {
        const latency = stats.recordLatencies.sort((a, b) => a - b);
        stats.recordHttp = {
          count: latency.length,
          p50Ms: latency[Math.ceil(latency.length * 0.5) - 1] ?? null,
          p95Ms: latency[Math.ceil(latency.length * 0.95) - 1] ?? null,
          maxMs: latency.at(-1) ?? null,
        };
        delete stats.recordLatencies;
        stats.rolesObserved = Object.keys(stats.peakByRole).length;
        const rolePeaks = {};
        for (const [role, count] of Object.entries(stats.peakByRole)) {
          const capability = roleLabels.get(role) ?? 'unclassified';
          (rolePeaks[capability] ??= []).push(count);
        }
        stats.perRolePeakDistribution = Object.fromEntries(
          Object.entries(rolePeaks).map(([capability, values]) => [capability, values.sort((a, b) => a - b)]),
        );
        delete stats.peakByRole;
      }
      report.checks.connectionBudget = Object.values(report.phases).every(
        stats => stats.peakConnections <= budgets.sampledDatabaseConnectionsMaximum,
      );
      report.checks.latencyBudget = ['baseline', 'mixed'].every(
        name =>
          report.phases[name]?.recordHttp.count > 0 &&
          report.phases[name].recordHttp.p95Ms < budgets.recordHttpP95MsExclusive,
      );
      report.checks.noUnauthorizedResults = Object.values(report.phases).every(
        stats => stats.unauthorizedResults === 0,
      );
      report.checks.noUnexpectedErrors = Object.keys(report.errors).length === 0;
      report.checks.rolloutDeadline = (report.flow.rolloutMs ?? Infinity) <= budgets.rolloutDeadlineMs;
      report.checks.sourceUnchanged =
        execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '' &&
        execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === head;
      report.passed =
        !failure &&
        Object.values(report.checks)
          .filter(value => typeof value === 'boolean')
          .every(Boolean);
      process.stdout.write(`CAPACITY_RESULT ${JSON.stringify(report)}\n`);
      if (artifactDirectory) writeFileSync(`${artifactDirectory}/result.json`, JSON.stringify(report, null, 2));
    }
    assert.equal(report.passed, true, 'Capacity gates failed; see sanitized CAPACITY_RESULT');
  },
);
import { provisionTestPgvector } from '../../../packages/workspace-storage/test/integration/pgvector.fixture.mjs';
