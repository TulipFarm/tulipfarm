import { NativeConnection, Worker } from '@temporalio/worker';
import { temporalConnectionOptions } from '@tulipfarm/config/temporal';
import { planDocumentRenderQueue } from '@tulipfarm/plan-documents';
import { createRenderActivities } from './activities.ts';
import { objectWriter } from './objects.ts';
import { createRenderer } from './render.ts';

const concurrency = Number.parseInt(process.env.RENDER_WORKER_CONCURRENCY ?? '2', 10);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
  throw new Error('RENDER_WORKER_CONCURRENCY must be between 1 and 16');

const renderer = await createRenderer({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
  sandbox: process.env.CHROMIUM_SANDBOX === 'true',
});
const objects = objectWriter();
const connection = await NativeConnection.connect(temporalConnectionOptions());
try {
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: planDocumentRenderQueue(process.env),
    activities: createRenderActivities(renderer, objects),
    maxConcurrentActivityTaskExecutions: concurrency,
    shutdownGraceTime: '30 seconds',
  });
  console.info(`Render worker polling ${planDocumentRenderQueue(process.env)}`);
  await worker.run();
} finally {
  await renderer.close();
  objects.close();
  await connection.close();
}
