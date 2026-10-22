import { createSnippetBroker } from '../src/broker.ts';

const broker = await createSnippetBroker({
  database: process.env.TEST_BROKER_DB,
  token: process.env.TEST_BROKER_TOKEN,
  image: process.env.SNIPPET_TEST_IMAGE,
  runtime: 'runc',
  allowLocalRunc: true,
  timeoutMs: 30000,
});
await new Promise(resolve => broker.server.listen(0, '127.0.0.1', resolve));
process.send({ port: broker.server.address().port });
process.on('SIGTERM', async () => {
  await broker.close();
  process.exit(0);
});
