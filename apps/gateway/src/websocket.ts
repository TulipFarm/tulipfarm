import type { Duplex } from 'node:stream';

// An unsolicited pong: RFC 6455 lets either side send one as a heartbeat, and the peer does not answer it.
const pong = Buffer.from([0x8a, 0x00]);
const closeOpcode = 0x8;
const longestHeader = 14;

function headerSize(header: Buffer) {
  if (header.length < 2) return null;
  const length = header[1]! & 0x7f;
  const masked = (header[1]! & 0x80) !== 0;
  return 2 + (length === 126 ? 2 : length === 127 ? 8 : 0) + (masked ? 4 : 0);
}

function payloadLength(header: Buffer) {
  const length = header[1]! & 0x7f;
  if (length === 126) return header.readUInt16BE(2);
  if (length === 127) return Number(header.readBigUInt64BE(2));
  return length;
}

/** Follows a WebSocket byte stream frame by frame, so another frame can go in only between two of them. */
export function frameCursor() {
  let header = Buffer.alloc(0);
  let payloadLeft = 0;
  let closed = false;
  return {
    get between() {
      return header.length === 0 && payloadLeft === 0;
    },
    /** Whether a close frame went by, after which nothing more may be sent. */
    get closed() {
      return closed;
    },
    read(chunk: Buffer) {
      let at = 0;
      while (at < chunk.length) {
        if (payloadLeft > 0) {
          const skipped = Math.min(payloadLeft, chunk.length - at);
          payloadLeft -= skipped;
          at += skipped;
          continue;
        }
        const before = header.length;
        header = Buffer.concat([header, chunk.subarray(at, at + longestHeader - before)]);
        const size = headerSize(header);
        if (size === null || header.length < size) {
          at += header.length - before;
          continue;
        }
        at += size - before;
        if ((header[0]! & 0x0f) === closeOpcode) closed = true;
        payloadLeft = payloadLength(header);
        header = Buffer.alloc(0);
      }
    },
  };
}

/**
 * Sends the client a pong whenever the app has sent nothing for `intervalMs`, between the app's frames. Load balancers
 * and CDNs close a connection that carries no bytes for their idle timeout, and an app may stay quiet for longer.
 * `head` is what the app sent before the socket was handed over.
 */
export function keepAlive(app: Duplex, client: Duplex, head: Buffer, intervalMs: number) {
  const frames = frameCursor();
  frames.read(head);
  const timer = setTimeout(function beat() {
    if (frames.closed || !client.writable) return;
    if (frames.between) client.write(pong);
    timer.refresh();
  }, intervalMs).unref();
  app.on('data', (chunk: Buffer) => {
    frames.read(chunk);
    timer.refresh();
  });
  client.once('close', () => clearTimeout(timer));
}
