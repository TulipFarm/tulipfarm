import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Client } from 'pg';
import { startNativePostgres } from './capacity-native-postgres.mjs';

test(
  'PostgreSQL TCP transport sustains short-lived connections',
  {
    skip: process.env.STORAGE_CAPACITY_NETWORK_TEST !== '1',
    timeout: 180000,
  },
  async t => {
    const directory = process.env.STORAGE_CAPACITY_ARTIFACTS;
    assert.ok(directory, 'Set STORAGE_CAPACITY_ARTIFACTS to preserve server evidence');
    mkdirSync(directory, { recursive: true });
    const name = `capacity-network-${randomUUID()}`;
    const report = { lanes: 16, pauseMs: 50, durationMs: 80000, seconds: {}, errors: [], snapshots: {} };
    const native = process.env.STORAGE_CAPACITY_POSTGRES_BIN ? await startNativePostgres({ network: true }) : undefined;
    if (native) t.after(() => native.close());
    report.environment = native?.metadata ?? { transport: 'docker-published-port', version: '18.3' };
    if (!native)
      execFileSync('docker', [
        'run',
        '-d',
        '--name',
        name,
        '-p',
        '127.0.0.1::5432',
        '-e',
        'POSTGRES_HOST_AUTH_METHOD=trust',
        'postgres:18.3',
        '-c',
        'max_connections=120',
        '-c',
        'log_disconnections=on',
        '-c',
        'log_error_verbosity=verbose',
        '-c',
        'log_line_prefix=%m [%p] %e ',
      ]);
    try {
      const port =
        native?.port ??
        Number(execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1));
      function capture(label) {
        report.snapshots[label] = new Date().toISOString();
        if (native) {
          writeFileSync(`${directory}/${label}-postgres.log`, native.logs());
          writeFileSync(`${directory}/${label}-native.json`, JSON.stringify(native.capture(), null, 2));
          return;
        }
        const ip = execFileSync(
          'docker',
          ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name],
          { encoding: 'utf8' },
        ).trim();
        assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
        for (const [file, args] of [
          ['postgres.log', ['logs', name]],
          ['inspect.json', ['inspect', '--format', '{"state":{{json .State}},"restarts":{{.RestartCount}}}', name]],
          ['processes.txt', ['top', name, '-eo', 'pid,ppid,stat,comm']],
          [
            'inside.txt',
            [
              'exec',
              name,
              'psql',
              '-U',
              'postgres',
              '-h',
              '127.0.0.1',
              '-c',
              'SELECT pg_postmaster_start_time(), count(*) FROM pg_stat_activity; SELECT extname, extversion FROM pg_extension',
            ],
          ],
          [
            'vm-network.txt',
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
          ],
        ]) {
          const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 15000 });
          writeFileSync(`${directory}/${label}-${file}`, result.stdout + result.stderr);
        }
      }
      let ready = false;
      for (let attempt = 0; attempt < 75; attempt++) {
        const client = new Client({ host: '127.0.0.1', port, user: 'postgres', connectionTimeoutMillis: 1000 });
        try {
          await client.connect();
          await client.query('SELECT 1');
          ready = true;
        } catch {
          await setTimeout(200);
        } finally {
          await client.end();
        }
        if (ready) break;
      }
      assert.ok(ready, 'Dedicated PostgreSQL must accept host TCP before measuring');
      capture('before');
      const started = performance.now();
      await Promise.all(
        Array.from({ length: report.lanes }, async () => {
          while (performance.now() - started < report.durationMs) {
            const second = Math.floor((performance.now() - started) / 1000);
            const bucket = (report.seconds[second] ??= { ok: 0, failed: 0 });
            const client = new Client({ host: '127.0.0.1', port, user: 'postgres', connectionTimeoutMillis: 5000 });
            client.on('error', error => {
              report.errors.push({ at: new Date().toISOString(), message: error.message });
            });
            try {
              await client.connect();
              assert.equal((await client.query('SELECT 1 AS value')).rows[0].value, 1);
              bucket.ok++;
            } catch (error) {
              bucket.failed++;
              if (report.errors.length < 5)
                report.errors.push({ at: new Date().toISOString(), message: error.message, code: error.code });
              if (!report.snapshots['first-error']) capture('first-error');
            } finally {
              await client.end();
            }
            await setTimeout(report.pauseMs);
          }
        }),
      );
      capture('after');
      report.passed = report.errors.length === 0 && Object.values(report.seconds).every(bucket => bucket.failed === 0);
    } finally {
      try {
        const logs = native
          ? native.logs()
          : (() => {
              const result = spawnSync('docker', ['logs', name], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
              return result.stdout + result.stderr;
            })();
        writeFileSync(`${directory}/final-postgres.log`, logs);
      } finally {
        try {
          if (native) await native.close();
          else execFileSync('docker', ['rm', '-f', '-v', name]);
          report.cleanup = true;
        } catch (error) {
          report.cleanup = false;
          report.passed = false;
          report.errors.push({ at: new Date().toISOString(), message: error.message });
        } finally {
          writeFileSync(`${directory}/result.json`, JSON.stringify(report, null, 2));
        }
      }
    }
    console.log(`CAPACITY_NETWORK_RESULT ${JSON.stringify(report)}`);
    assert.equal(report.passed, true, 'TCP network gate failed; inspect preserved server diagnostics');
  },
);
