import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

export async function runLogged(command, args, parent = 'reports/check', summaryPath) {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'run-'));
  const log = join(directory, 'stdout.log');
  const errorLog = join(directory, 'stderr.log');
  await writeFile(join(directory, 'command.json'), JSON.stringify({ command, args }));
  const output = createWriteStream(log);
  const errors = createWriteStream(errorLog);
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(errors, { end: false });
  let interrupted;
  let escalation;
  const signalGroup = signal => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (!['EPERM', 'ESRCH'].includes(error.code)) throw error;
    }
  };
  const forward = signal => {
    interrupted ??= signal;
    signalGroup(signal);
    escalation ??= setTimeout(() => signalGroup('SIGKILL'), 3000);
  };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', terminate);
  const owner = process.ppid;
  const ownerWatch = setInterval(() => {
    if (process.ppid !== owner) forward('SIGTERM');
  }, 1000);
  child.once('exit', () => {
    signalGroup('SIGTERM');
    escalation ??= setTimeout(() => signalGroup('SIGKILL'), 3000);
  });
  let startError;
  child.on('error', error => {
    startError = error.message;
  });
  const invocation = `${command} ${args.join(' ')}`;
  process.stdout.write(
    `Running ${invocation.length > 300 ? `${invocation.slice(0, 300)}… (see command.json)` : invocation}\nLogs: ${resolve(directory)}\n`,
  );
  const heartbeat = setInterval(() => process.stdout.write(`Checks running; logs: ${resolve(directory)}\n`), 60000);
  let code;
  try {
    code = await new Promise(resolveExit =>
      child.once('close', (status, signal) =>
        resolveExit(
          startError
            ? 1
            : interrupted === 'SIGINT' || signal === 'SIGINT'
              ? 130
              : interrupted || signal === 'SIGTERM'
                ? 143
                : (status ?? 1),
        ),
      ),
    );
    if (startError) errors.write(`${startError}\n`);
    output.end();
    errors.end();
    await Promise.all([finished(output), finished(errors)]);
  } finally {
    clearInterval(heartbeat);
    clearInterval(ownerWatch);
    clearTimeout(escalation);
    signalGroup('SIGKILL');
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    process.off('SIGHUP', terminate);
  }
  const lines = [];
  for (const file of [log, errorLog]) {
    const recent = [];
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      recent.push(stripVTControlCharacters(line).slice(0, 500));
      if (recent.length > 30) recent.shift();
    }
    if (recent.length) lines.push(`${file}:`, ...recent);
  }
  const summary = `## Repository checks\n\n${code === 0 ? 'PASS' : 'FAIL'}. Exit code ${code}. Logs: \`${directory}\`.\n\n<details>\n<summary>Last 30 lines of each output stream</summary>\n\n\`\`\`text\n${lines.join('\n').replaceAll('```', "'''")}\n\`\`\`\n</details>\n`;
  await writeFile(join(directory, 'summary.md'), summary);
  if (summaryPath) await appendFile(summaryPath, summary);
  process.stdout.write(
    `${lines.join('\n')}\n${code === 0 ? 'PASS' : 'FAIL'}: exit ${code}. Logs: ${resolve(directory)}\n`,
  );
  return { code, directory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Usage: node tooling/check-logged.mjs <command> [args...]');
  const result = await runLogged(command, args, 'reports/check', process.env.GITHUB_STEP_SUMMARY);
  process.exitCode = result.code;
}
