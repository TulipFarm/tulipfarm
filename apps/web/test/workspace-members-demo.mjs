import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { ZodError } from 'zod';
import { createWorkspaceMembersMock } from '../src/features/tables/workspace-members-mock-api.ts';

export async function startWorkspaceMembersDemo({ port = 5793, scenario } = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const mock = createWorkspaceMembersMock(scenario);
  const streams = new Set();
  const plugin = {
    name: 'workspace-members-local-demo',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, origin);
        if (!url.pathname.startsWith('/v1/')) return next();
        const json = (body, status) => {
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(body));
        };
        if (
          request.headers.host !== new URL(origin).host ||
          request.headers['sec-fetch-site'] === 'cross-site' ||
          (request.headers.origin && request.headers.origin !== origin)
        )
          return json({ error: 'local-demo-origin-required' }, 403);
        if (request.method === 'GET' && url.pathname === '/v1/feature-flags') return json({}, 200);
        if (request.method === 'GET' && url.pathname === `/v1/workspaces/${mock.workspaceId}/recommendations/events`) {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          response.write(': local member demo\n\n');
          streams.add(response);
          const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 10000);
          response.on('close', () => {
            streams.delete(response);
            clearInterval(heartbeat);
          });
          return;
        }
        try {
          let text = '';
          for await (const chunk of request) {
            text += chunk;
            if (text.length > 131072) return json({ error: 'mock-request-too-large' }, 413);
          }
          const result = await mock.handle(url, request.method ?? 'GET', text ? JSON.parse(text) : null);
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.end(Buffer.from(await result.arrayBuffer()));
        } catch (error) {
          console.error('Member demo request failed:', error);
          json(
            { error: 'member-demo-request-failed' },
            error instanceof SyntaxError || error instanceof ZodError ? 400 : 500,
          );
        }
      });
    },
  };
  const root = fileURLToPath(new URL('..', import.meta.url));
  const previousOrigin = process.env.VITE_API_URL;
  let server;
  try {
    process.env.VITE_API_URL = origin;
    server = await createServer({
      root,
      configFile: `${root}/vite.config.ts`,
      plugins: [plugin],
      server: { host: '127.0.0.1', port, strictPort: true },
    });
  } finally {
    if (previousOrigin === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = previousOrigin;
  }
  await server.listen();
  return {
    origin,
    close: async () => {
      for (const stream of streams) stream.end();
      await server.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demo = await startWorkspaceMembersDemo({
    port: Number(process.env.WORKSPACE_MEMBERS_PORT ?? 5793),
    scenario: process.env.WORKSPACE_MEMBERS_SCENARIO,
  });
  console.log(`Workspace members demo: ${demo.origin}/members-table-mock/tables/87654321-4321-4321-8321-000000000010`);
  console.log(
    'Local mock data only. Reloads retain edits; stopping this server discards them. No real API, mail, or model calls.',
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await demo.close();
      process.exit(0);
    });
}
