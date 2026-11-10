import { runIsolated, type ChatExecutionResult } from '@tulipfarm/agents/chat-execution';
import type { ExecutionBackend, ExecutionCommand, ExecutionConfiguration } from '@tulipfarm/execution-contract';
import {
  snippetPayloadSchema,
  type SnippetClient,
  type SnippetJob,
  type SnippetResult,
} from '@tulipfarm/workflow-snippets/protocol';

// A workflow activity may run for 30 seconds, so a step's machine, code and cleanup must fit well inside that.
const stepTimeoutMs = 20000;

// JavaScript, TypeScript and Python steps run as the body of a function that receives `input`; its return value
// is printed as JSON. Anything the code itself prints goes to stderr, so stdout holds only that value.
const javascript = `const write = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
const [source, input] = process.argv.slice(-2);
const AsyncFunction = (async () => {}).constructor;
new AsyncFunction('input', 'require', source)(JSON.parse(input), require).then(
  value => write(JSON.stringify(value ?? null)),
  error => { console.error(error); process.exitCode = 1; },
);`;
const typescript = (source: string) => `const write = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
(async (input: any): Promise<unknown> => {
${source}
})(JSON.parse(process.argv.at(-1) ?? 'null')).then(
  value => write(JSON.stringify(value ?? null)),
  error => { console.error(error); process.exitCode = 1; },
);`;
const python = `import json, sys
source, raw = sys.argv[1], sys.argv[2]
out, sys.stdout = sys.stdout, sys.stderr
body = "def step(input):\\n" + "".join("    " + line + "\\n" for line in source.splitlines()) + "    pass\\n"
scope = {}
exec(compile(body, "<step>", "exec"), scope)
out.write(json.dumps(scope["step"](json.loads(raw)), allow_nan=False))
out.flush()`;

export function stepCommand(language: SnippetJob['language'], source: string, input: string): ExecutionCommand {
  switch (language) {
    case 'javascript':
      return { program: 'node', args: ['-e', javascript, '--', source, input] };
    case 'typescript':
      return { program: 'node', args: ['--input-type=commonjs-typescript', '-e', typescript(source), '--', input] };
    case 'python':
      return { program: 'python3', args: ['-c', python, source, input] };
    case 'bash':
      // Bash steps read the input JSON from $INPUT and print their output.
      return { program: 'bash', args: ['-c', `INPUT=$1\n${source}`, 'step', input] };
  }
}

export function stepResult(language: SnippetJob['language'], run: ChatExecutionResult): SnippetResult {
  if (run.state === 'timed-out') return { kind: 'failed', error: 'deadline' };
  if (run.state !== 'completed') return { kind: 'failed', error: 'interrupted' };
  if (run.truncated) return { kind: 'failed', error: 'output-limit' };
  if (run.exitCode !== 0) return { kind: 'failed', error: 'execution-failed' };
  let output: unknown;
  if (language === 'bash') {
    const text = run.stdout.trim();
    try {
      output = JSON.parse(text);
    } catch {
      output = text;
    }
  } else {
    try {
      output = JSON.parse(run.stdout);
    } catch {
      return { kind: 'failed', error: 'invalid-output' };
    }
  }
  const parsed = snippetPayloadSchema.safeParse(output);
  return parsed.success ? { kind: 'completed', output: parsed.data } : { kind: 'failed', error: 'output-limit' };
}

/** Runs workflow code steps in fresh machines from the configured execution backend. */
export function createExecutionSnippetClient(
  backend: ExecutionBackend,
  configuration: Exclude<ExecutionConfiguration, { mode: 'off' }>,
): SnippetClient {
  return {
    async submit(job) {
      const run = await runIsolated(backend, configuration, {
        areaId: job.runId,
        command: stepCommand(job.language, job.source, JSON.stringify(job.input)),
        timeoutMs: stepTimeoutMs,
      });
      return stepResult(job.language, run);
    },
  };
}
