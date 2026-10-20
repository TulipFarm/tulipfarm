import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Client } from 'pg';

export async function startNativePostgres({ network = false } = {}) {
  const bin = process.env.STORAGE_CAPACITY_POSTGRES_BIN;
  assert.ok(bin, 'Set STORAGE_CAPACITY_POSTGRES_BIN to a PostgreSQL 18 binary directory');
  const version = execFileSync(join(bin, 'postgres'), ['--version'], { encoding: 'utf8' }).trim();
  assert.match(version, /PostgreSQL\) 18\./);
  const directory = mkdtempSync(join(tmpdir(), 'capacity-native-'));
  const data = join(directory, 'data');
  const log = join(directory, 'postgres.log');
  let child;
  let spawnError;
  async function close() {
    for (const signal of ['SIGINT', 'SIGQUIT']) {
      if (!child || spawnError || child.exitCode !== null || child.signalCode !== null) break;
      child.kill(signal);
      const deadline = performance.now() + 15000;
      while (child.exitCode === null && child.signalCode === null && performance.now() < deadline) await setTimeout(50);
    }
    assert.ok(
      !child || spawnError || child.exitCode !== null || child.signalCode !== null,
      `PostgreSQL still running; retained ${directory}`,
    );
    rmSync(directory, { recursive: true, force: true });
  }
  try {
    const passwordFile = join(directory, 'password');
    writeFileSync(passwordFile, 'local-postgres\n', { mode: 0o600 });
    execFileSync(
      join(bin, 'initdb'),
      [
        '-D',
        data,
        '-U',
        'postgres',
        '--encoding=UTF8',
        '--locale=C',
        '--auth-local=trust',
        `--auth-host=${network ? 'trust' : 'scram-sha-256'}`,
        `--pwfile=${passwordFile}`,
      ],
      { stdio: 'pipe' },
    );
    rmSync(passwordFile);
    const reservation = createServer();
    await new Promise((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(error => (error ? reject(error) : resolve())));
    const descriptor = openSync(log, 'a', 0o600);
    try {
      child = spawn(
        join(bin, 'postgres'),
        [
          '-D',
          data,
          '-h',
          '127.0.0.1',
          '-p',
          String(port),
          '-c',
          'unix_socket_directories=',
          '-c',
          'max_connections=120',
          '-c',
          'log_disconnections=on',
          '-c',
          'log_error_verbosity=verbose',
          '-c',
          'log_min_error_statement=panic',
          '-c',
          'log_line_prefix=%m [%p] %q%u@%d/%a %e ',
        ],
        { stdio: ['ignore', descriptor, descriptor] },
      );
      child.on('error', error => {
        spawnError = error;
      });
    } finally {
      closeSync(descriptor);
    }
    const connection = {
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password: 'local-postgres',
      database: 'postgres',
      connectionTimeoutMillis: 1000,
    };
    let settings;
    let readinessError;
    for (let attempt = 0; attempt < 75; attempt++) {
      if (spawnError) throw spawnError;
      assert.ok(child.exitCode === null && child.signalCode === null, readFileSync(log, 'utf8'));
      const client = new Client(connection);
      try {
        await client.connect();
        settings = (
          await client.query(
            "SELECT current_setting('data_directory') AS directory, version(), current_setting('max_connections') AS max_connections, current_setting('listen_addresses') AS listen_addresses, current_setting('server_encoding') AS encoding, datcollate AS collate, pg_postmaster_start_time() AS started FROM pg_database WHERE datname = current_database()",
          )
        ).rows[0];
      } catch (error) {
        readinessError = error;
        await setTimeout(200);
      } finally {
        await client.end();
      }
      if (settings) break;
    }
    assert.ok(settings, `Owned native PostgreSQL must accept TCP before measuring: ${readinessError?.message}`);
    assert.equal(settings.directory, data);
    assert.equal(settings.max_connections, '120');
    const metadata = {
      transport: 'native-loopback',
      binary: join(bin, 'postgres'),
      version,
      port,
      pid: child.pid,
      ...settings,
    };
    return {
      port,
      metadata,
      close,
      logs: () => readFileSync(log, 'utf8'),
      capture() {
        const sql = spawnSync(
          join(bin, 'psql'),
          [
            '-X',
            '-h',
            '127.0.0.1',
            '-p',
            String(port),
            '-U',
            'postgres',
            '-d',
            'postgres',
            '-c',
            'SELECT pg_postmaster_start_time(), count(*) FROM pg_stat_activity; SELECT extname, extversion FROM pg_extension',
          ],
          {
            encoding: 'utf8',
            env: { ...process.env, PGPASSWORD: 'local-postgres', PGCONNECT_TIMEOUT: '3' },
            timeout: 5000,
          },
        );
        const processes = spawnSync('ps', ['-p', String(child.pid), '-o', 'pid,ppid,stat,comm'], {
          encoding: 'utf8',
          timeout: 5000,
        });
        return {
          at: new Date().toISOString(),
          ...metadata,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
          sql: { status: sql.status, output: sql.stdout + sql.stderr },
          processes: { status: processes.status, output: processes.stdout + processes.stderr },
        };
      },
    };
  } catch (error) {
    if (process.env.STORAGE_CAPACITY_ARTIFACTS) {
      try {
        writeFileSync(join(process.env.STORAGE_CAPACITY_ARTIFACTS, 'startup-postgres.log'), readFileSync(log));
      } catch {}
    }
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Native PostgreSQL startup and cleanup failed');
    }
    throw error;
  }
}
