import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';

export type EgressOptions = {
  /** Whether Chromium may connect to this resolved address. */
  allowed: (address: string) => boolean;
  resolve?: (host: string) => Promise<string[]>;
};

const resolveAll = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map(item => item.address);

/**
 * The only way out for Chromium. Each connection, including every redirect hop and websocket, is resolved here once,
 * checked, and opened to that same address, so neither a redirect nor a DNS answer that changes can reach a private
 * network.
 */
export async function startEgressProxy(options: EgressOptions) {
  const resolve = options.resolve ?? resolveAll;

  async function destination(host: string): Promise<string | null> {
    const bare = host.replace(/^\[|\]$/g, '');
    const addresses = isIP(bare) ? [bare] : await resolve(bare).catch(() => []);
    if (!addresses.length || !addresses.every(options.allowed)) return null;
    return addresses[0]!;
  }

  // Upstream requests and tunnels, so a cancelled request or a shutdown never leaves one open.
  const open = new Set<{ destroy: () => unknown }>();
  function track<T extends { destroy: () => unknown; once: (event: 'close', listener: () => void) => unknown }>(
    item: T,
  ) {
    open.add(item);
    item.once('close', () => open.delete(item));
    return item;
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void forward(request, response);
  });

  async function forward(request: IncomingMessage, response: ServerResponse) {
    const target = URL.parse(request.url ?? '');
    if (!target || target.protocol !== 'http:') return refuse(response, 400);
    const address = await destination(target.hostname);
    if (!address) return refuse(response, 403);
    const headers = { ...request.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    if (response.destroyed) return;
    const upstream = track(
      httpRequest(
        {
          host: address,
          port: Number(target.port || 80),
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers,
          setHost: false,
        },
        answer => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.on('error', () => response.destroy());
          answer.once('close', () => {
            if (!answer.complete) response.destroy();
          });
          answer.pipe(response);
        },
      ),
    );
    upstream.on('error', () => refuse(response, 502));
    response.once('close', () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.pipe(upstream);
  }

  function refuse(response: ServerResponse, status: number) {
    if (response.headersSent) return response.destroy();
    response.writeHead(status, { 'content-type': 'text/plain' }).end('Blocked by the browser host');
  }

  server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
    client.on('error', () => undefined);
    const target = URL.parse(`http://${request.url ?? ''}`);
    void (async () => {
      const address = target ? await destination(target.hostname) : null;
      if (!target || !address) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      if (client.destroyed) return;
      let established = false;
      const upstream = track(
        connect(Number(target.port || 443), address, () => {
          established = true;
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        }),
      );
      upstream.on('error', () => (established ? client.destroy() : client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')));
      upstream.once('close', () => client.destroy());
      client.once('close', () => upstream.destroy());
    })();
  });
  // Chromium tunnels websockets with CONNECT; a plain upgrade through the proxy is refused.
  server.on('upgrade', (_request: IncomingMessage, socket: Socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));

  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    server: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>(done => {
        for (const item of open) item.destroy();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
