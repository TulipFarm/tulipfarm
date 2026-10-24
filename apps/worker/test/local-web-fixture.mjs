import { createServer } from 'node:http';
import { connect } from 'node:net';
import { publicNetwork } from '@tulipfarm/agents/web-fetch';
import { Agent } from 'undici';

/**
 * Serves `routes` on a local port and routes every public link there. DNS answers come from `dns`; each connection
 * goes through the production pinned lookup, and the address it returned is recorded. Only these two network
 * functions are replaced; the address checks, redirects and bounds are production code.
 */
export async function localWeb(t, routes, dns = () => ['93.184.216.34']) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.headers.host}${request.url}`);
    const route = routes[`${request.headers.host}${request.url}`];
    if (!route) return response.writeHead(404).end();
    route(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const resolved = [];
  const connected = [];
  t.mock.method(publicNetwork, 'resolve', async hostname => {
    resolved.push(hostname);
    return dns(hostname, resolved.filter(name => name === hostname).length);
  });
  t.mock.method(
    publicNetwork,
    'dispatcher',
    pinned =>
      new Agent({
        connect(options, callback) {
          pinned(options.hostname, {}, (error, address) => {
            if (error) return callback(error, null);
            connected.push({ hostname: options.hostname, address });
            const socket = connect(port, '127.0.0.1');
            socket.once('connect', () => callback(null, socket)).once('error', cause => callback(cause, null));
          });
        },
      }),
  );
  return { requests, resolved, connected };
}

export const send =
  (status, body = '', headers = {}) =>
  (_request, response) =>
    response.writeHead(status, headers).end(body);
