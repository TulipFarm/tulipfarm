import { buildApp } from '../dist/app.js';

const app = buildApp({ agentModel: null });
const address = await app.listen({ host: '127.0.0.1', port: 0 });
process.send({ address });
process.on('SIGTERM', async () => {
  await app.close();
  process.exit(0);
});
