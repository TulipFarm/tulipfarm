// Preloaded into a browser test that run-browser-tests.mjs starts in its own network namespace.
// The namespace has only loopback, so this forwards the test database's loopback port to the
// runner's Unix socket outside it, which forwards on to the real database.
import { createConnection, createServer } from 'node:net';

const socketPath = process.env.TULIPFARM_TEST_DATABASE_SOCKET;
const port = Number(process.env.TULIPFARM_TEST_DATABASE_PORT);

if (socketPath && port) {
  const server = createServer(client => {
    const upstream = createConnection(socketPath);
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', error => (error.code === 'EADDRINUSE' ? resolve() : reject(error)));
    server.listen(port, '127.0.0.1', resolve);
  });
  server.unref();
}
