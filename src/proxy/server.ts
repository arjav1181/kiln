import { createServer, request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { INJECTED_CLIENT } from './client-script.ts';

export type ProxyOptions = {
  host: string;
  port: number;
  /**
   * Mutable so the daemon can publish its origin once it is listening. The
   * client script is served from the proxy's own origin, which keeps the script
   * same-origin with the page it instruments.
   */
  client: { origin: string };
};

const CLIENT_PATH = '/__kiln/client.js';

const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)/i;



/** Headers that would break the preview once we sit in front of it. */
const STRIPPED = ['content-length', 'content-encoding', 'x-frame-options', 'content-security-policy'];

function injectIntoHead(html: string): string {
  const tag = `<script src="${CLIENT_PATH}" defer></script>`;
  const head = html.match(/<head[^>]*>/i);
  if (head?.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

/**
 * rawHeaders is a flat [name, value, ...] array, so it has to be re-paired into
 * `Name: value` lines. Joining it directly produces a malformed handshake.
 */
function upgradeResponse(res: { statusCode?: number; statusMessage?: string; rawHeaders: string[] }): string {
  const lines = [`HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? 'Switching Protocols'}`];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

export function createProxy(options: ProxyOptions) {
  const { host, port } = options;
  // Upgraded sockets outlive the request, so they have to be tracked
  // explicitly or close() leaves them holding the port.
  const upgraded = new Set<Duplex>();

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    if (path === CLIENT_PATH) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(INJECTED_CLIENT.replace('__KILN_ORIGIN__', JSON.stringify(options.client.origin)));
      return;
    }

    const upstream = httpRequest(
      { host, port, path: req.url, method: req.method, headers: { ...req.headers, host: `${host}:${port}` } },
      (upstreamRes) => {
        const type = String(upstreamRes.headers['content-type'] ?? '');
        const headers = { ...upstreamRes.headers };
        for (const name of STRIPPED) delete headers[name];

        if (!HTML_TYPES.test(type)) {
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          upstreamRes.pipe(res);
          return;
        }

        const chunks: Buffer[] = [];
        upstreamRes.on('data', (c: Buffer) => chunks.push(c));
        upstreamRes.on('end', () => {
          const original = Buffer.concat(chunks).toString('utf8');
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          res.end(Buffer.from(injectIntoHead(original), 'utf8'));
        });
      },
    );

    upstream.on('error', (error) => {
      if (res.headersSent) res.end();
      else res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Preview upstream error: ${error.message}`);
    });

    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    // The browser tears these down abruptly on reload; without a handler the
    // ECONNRESET becomes an unhandled error event and kills the daemon.
    socket.on('error', () => socket.destroy());
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));

    const upstream = httpRequest({
      host,
      port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${host}:${port}` },
    });

    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      upstreamSocket.on('error', () => socket.destroy());
      socket.write(upgradeResponse(upstreamRes));
      if (upstreamHead?.length) socket.unshift(upstreamHead);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });

    upstream.on('error', () => socket.destroy());
    if (head?.length) upstream.write(head);
    upstream.end();
  });

  return {
    listen: (proxyPort: number) =>
      new Promise<number>((resolve) => {
        server.listen(proxyPort, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of upgraded) socket.destroy();
        upgraded.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export { injectIntoHead, CLIENT_PATH };
