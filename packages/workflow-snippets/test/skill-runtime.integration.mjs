import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnippetRunner, SnippetError } from '../dist/index.js';
import { skillJobSchema, skillResultSchema } from '../dist/skill-protocol.js';

test('skill packages execute Bash, Python and Node with immutable local files and bounded outputs', async t => {
  assert.ok(process.env.SNIPPET_TEST_IMAGE, 'SNIPPET_TEST_IMAGE must name the built image digest');
  const owner = randomUUID();
  t.after(() => rm(join(tmpdir(), `tf-skills-${owner}`), { recursive: true, force: true }));
  const runner = createSnippetRunner({
    image: process.env.SNIPPET_TEST_IMAGE,
    runtime: 'runc',
    allowLocalRunc: true,
    owner,
  });
  const scripts = {
    bash: 'cat data.txt > "$TULIPFARM_OUTPUT_DIR/result.txt"\nprintf "done"',
    python:
      'import os\nfrom helper import value\nopen(os.environ["TULIPFARM_OUTPUT_DIR"] + "/result.txt", "w").write(value)\nprint("done", end="")',
    node: 'const fs = require("node:fs"); fs.copyFileSync("/package/data.txt", process.env.TULIPFARM_OUTPUT_DIR + "/result.txt"); process.stdout.write("done");',
  };
  const makeJob = (language, source) =>
    skillJobSchema.parse({
      kind: 'skill',
      version: 1,
      workspaceId: randomUUID(),
      invocationId: randomUUID(),
      packageDigest: 'a'.repeat(64),
      language,
      entrypoint: 'script',
      args: [],
      input: null,
      files: Object.entries({ script: source, 'data.txt': 'exact bytes', 'helper.py': 'value = "exact bytes"' }).map(
        ([path, content]) => ({
          path,
          content: Buffer.from(content).toString('base64'),
          digest: createHash('sha256').update(content).digest('hex'),
        }),
      ),
    });
  for (const [language, source] of Object.entries(scripts)) {
    const result = skillResultSchema.parse(await runner.executeSkill(makeJob(language, source)));
    assert.equal(result.kind, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'done');
    assert.equal(Buffer.from(result.files[0].content, 'base64').toString(), 'exact bytes');
  }
  const isolated = await runner.executeSkill(
    makeJob(
      'python',
      `import os, socket
assert "SNIPPET_BROKER_TOKEN" not in os.environ
try:
    open("/package/data.txt", "w").write("changed")
    raise AssertionError("package writable")
except OSError:
    pass
try:
    os.chmod("/package/data.txt", 0o777)
    raise AssertionError("package mutable")
except OSError:
    pass
try:
    socket.create_connection(("1.1.1.1", 443), timeout=1)
    raise AssertionError("network enabled")
except OSError:
    pass
print("isolated", end="")
`,
    ),
  );
  assert.equal(isolated.stdout, 'isolated');
  const tampered = makeJob('bash', 'true');
  tampered.files[0].digest = 'f'.repeat(64);
  await assert.rejects(runner.executeSkill(tampered), /invalid-input/);
  for (const script of [
    'ln -s /etc/passwd "$TULIPFARM_OUTPUT_DIR/link.txt"',
    'mkfifo "$TULIPFARM_OUTPUT_DIR/pipe.txt"',
    'head -c 131073 /dev/zero',
    'head -c 10485761 /dev/zero > "$TULIPFARM_OUTPUT_DIR/large.txt"',
  ]) {
    await assert.rejects(runner.executeSkill(makeJob('bash', script)), SnippetError);
  }
  const boundary = await runner.executeSkill(makeJob('python', 'print("x" * 131072, end="")'));
  assert.equal(boundary.stdout.length, 131072, 'The exact combined log limit is accepted');
  const failed = await runner.executeSkill(makeJob('bash', 'printf "missing dependency" >&2; exit 127'));
  assert.equal(failed.exitCode, 127);
  assert.equal(failed.stderr, 'missing dependency');
  assert.equal(
    (await runner.executeSkill(makeJob('bash', scripts.bash))).stdout,
    'done',
    'Rejected outputs do not exhaust runner capacity',
  );
  await runner.reconcile();
});
