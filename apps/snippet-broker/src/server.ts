import '@tulipfarm/config/load-secret-files';
import { readFile } from 'node:fs/promises';
import { readBuildInfo } from '@tulipfarm/build-info/node';
import { startTelemetry } from '@tulipfarm/observability';
import { z } from 'zod';
import { createSnippetBroker } from '@tulipfarm/workflow-snippets/broker';

const telemetry = startTelemetry(readBuildInfo('snippet-broker', new URL('../version.json', import.meta.url)));

async function main() {
  const env = z
    .object({
      SNIPPET_IMAGE: z.string(),
      SNIPPET_BROKER_TOKEN_FILE: z.string().min(1),
      SNIPPET_DATABASE: z.string().default('/data/jobs.sqlite'),
      SNIPPET_RUNTIME: z.enum(['runsc', 'runc']).default('runsc'),
      SNIPPET_ALLOW_LOCAL_RUNC: z.enum(['true', 'false']).default('false'),
      SKILL_SCRIPTS_ENABLED: z.enum(['true', 'false']).default('false'),
      HOST: z.string().default('127.0.0.1'),
      PORT: z.coerce.number().int().min(1).max(65535).default(8090),
    })
    .parse(process.env);
  const broker = await createSnippetBroker({
    database: env.SNIPPET_DATABASE,
    token: (await readFile(env.SNIPPET_BROKER_TOKEN_FILE, 'utf8')).trim(),
    image: env.SNIPPET_IMAGE,
    runtime: env.SNIPPET_RUNTIME,
    allowLocalRunc: env.SNIPPET_ALLOW_LOCAL_RUNC === 'true',
    enableSkillJobs: env.SKILL_SCRIPTS_ENABLED === 'true',
  });
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      void broker
        .close()
        .then(() => telemetry?.shutdown())
        .then(
          () => process.exit(0),
          () => process.exit(1),
        );
    });
  await new Promise<void>((resolve, reject) => {
    broker.server.once('error', reject);
    broker.server.listen(env.PORT, env.HOST, resolve);
  });
}
main().catch(async () => {
  process.stderr.write('snippet-broker-startup-failed\n');
  await telemetry?.shutdown();
  process.exitCode = 1;
});
