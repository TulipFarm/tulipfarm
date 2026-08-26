/**
 * Source of the development egress proxy, embedded as text so the port has no packaging or
 * repository-path dependency: it writes this to a temporary file and bind-mounts it into the
 * sandbox runtime image, which already carries a `node` binary.
 *
 * Deliberately written without template literals so it survives embedding unescaped.
 */
export const EGRESS_PROXY_SOURCE = String.raw`
// Allowlisting forward proxy for development sandbox egress. Refuses every destination the
// control plane did not declare, and every port other than 80 and 443.
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";

const allowed = new Set(
  (process.env.TULIP_ALLOWED_HOSTS || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
);
const port = Number(process.env.TULIP_PROXY_PORT || "8888");
const idleTimeoutMs = Number(process.env.TULIP_IDLE_TIMEOUT_SECONDS || "900") * 1000;
const ALLOWED_PORTS = new Set([80, 443]);

function permitted(host, destinationPort) {
  if (typeof host !== "string" || host.length === 0) return false;
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return allowed.has(normalized) && ALLOWED_PORTS.has(Number(destinationPort));
}

function splitAuthority(authority) {
  const index = authority.lastIndexOf(":");
  if (index === -1) return { host: authority, port: 443 };
  return { host: authority.slice(0, index), port: Number(authority.slice(index + 1)) };
}

let idleTimer;
function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), idleTimeoutMs);
  idleTimer.unref();
}

const server = createServer((req, res) => {
  touch();
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400).end("bad_request");
    return;
  }
  const destinationPort = target.port === "" ? 80 : Number(target.port);
  if (target.protocol !== "http:" || !permitted(target.hostname, destinationPort)) {
    res.writeHead(403).end("destination_denied");
    return;
  }
  const upstream = httpRequest(
    {
      host: target.hostname,
      port: destinationPort,
      method: req.method,
      path: target.pathname + target.search,
      headers: req.headers,
    },
    (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    }
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("upstream_error");
  });
  req.pipe(upstream);
});

// HTTPS arrives as CONNECT, so the proxy sees the authority but never the payload.
server.on("connect", (req, clientSocket, head) => {
  touch();
  const { host, port: destinationPort } = splitAuthority(req.url || "");
  if (!permitted(host, destinationPort)) {
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const upstream = netConnect(destinationPort, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const shutdown = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on("error", shutdown);
  clientSocket.on("error", shutdown);
});

server.listen(port, "0.0.0.0", () => {
  touch();
  process.stdout.write("egress proxy listening on " + port + " for " + [...allowed].join(",") + "\n");
});
`;
