import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectElement } from '../capture/element.ts';
import type { App, AppNotice } from './app.ts';
import type { KilnEvent } from '../sdk/events.ts';
import type { PermissionDecision } from '../sdk/events.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const UI_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'ui', 'dist');

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function sendJson(res: ServerResponse, status: number, payload: unknown): Promise<void> {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Serves one file from the built UI, refusing anything that escapes the root. */
async function serveStatic(res: ServerResponse, relative: string): Promise<boolean> {
  const target = normalize(join(UI_ROOT, relative === '/' ? 'index.html' : relative));
  if (!target.startsWith(UI_ROOT)) return false;
  if (!existsSync(target)) return false;
  const info = await stat(target);
  if (!info.isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(target).pipe(res);
  return true;
}

export type ServerHandle = {
  port: number;
  close: () => Promise<void>;
};

export function createDaemon(app: App): {
  listen: (port?: number) => Promise<ServerHandle>;
} {
  const clients = new Set<ServerResponse>();

  const broadcast = (event: KilnEvent | AppNotice) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  };

  const unsubscribe = app.subscribe(broadcast);

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write(': connected\n\n');
      clients.add(res);
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
      keepAlive.unref?.();
      req.on('close', () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }

    if (path === '/api/outstanding' && req.method === 'GET') {
      await sendJson(res, 200, { outstanding: (await app.state()).outstanding });
      return;
    }

    if (path === '/api/state' && req.method === 'GET') {
      await sendJson(res, 200, await app.state());
      return;
    }

    if (path === '/api/prompt' && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text ?? '').trim();
      if (!text) {
        await sendJson(res, 400, { error: 'empty prompt' });
        return;
      }
      try {
        await sendJson(res, 200, await app.prompt(text));
      } catch (error) {
        await sendJson(res, 409, { error: (error as Error).message });
      }
      return;
    }

    if (path === '/api/interrupt' && req.method === 'POST') {
      await app.interrupt();
      await sendJson(res, 200, { ok: true });
      return;
    }

    if (path === '/api/permission' && req.method === 'POST') {
      const body = await readBody(req);
      const decision: PermissionDecision =
        body.allow === true
          ? { allow: true, remember: body.remember === true }
          : { allow: false, reason: String(body.reason ?? 'The user denied this tool call.') };
      const settled = app.answerPermission(String(body.requestId ?? ''), decision);
      await sendJson(res, settled ? 200 : 404, { ok: settled });
      return;
    }

    if (path === '/api/question' && req.method === 'POST') {
      const body = await readBody(req);
      const settled = app.answerQuestion(String(body.requestId ?? ''), String(body.answer ?? ''));
      await sendJson(res, settled ? 200 : 404, { ok: settled });
      return;
    }

    if (path === '/api/restore' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        await app.restore(String(body.checkpointId ?? ''));
        await sendJson(res, 200, { ok: true });
      } catch (error) {
        await sendJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (path === '/api/dev-command' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        await app.setDevCommand(String(body.command ?? ''));
        await sendJson(res, 200, { ok: true, preview: app.preview() });
      } catch (error) {
        await sendJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (path === '/__kiln/report' && req.method === 'POST') {
      const body = await readBody(req);
      app.noteError(String(body.level ?? 'error'), String(body.text ?? ''));
      await sendJson(res, 200, { ok: true });
      return;
    }

    if (path === '/api/remote' && req.method === 'GET') {
      await sendJson(res, 200, await app.remoteStatus());
      return;
    }

    if (path === '/api/remote/connect' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        await sendJson(res, 200, await app.connectRemote(String(body.url ?? '')));
      } catch (error) {
        await sendJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (path === '/api/remote/push' && req.method === 'POST') {
      try {
        await sendJson(res, 200, await app.push());
      } catch (error) {
        await sendJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (path === '/api/remote/pr' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        await sendJson(res, 200, await app.openPullRequest(body.title as string, body.body as string));
      } catch (error) {
        await sendJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (path === '/api/publish' && req.method === 'GET') {
      await sendJson(res, 200, await app.publishTarget());
      return;
    }

    if (path === '/api/publish/scaffold' && req.method === 'POST') {
      try {
        await sendJson(res, 200, await app.writePublishScaffold());
      } catch (error) {
        await sendJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (path === '/api/select' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const resolved = await app.resolveSelection({
          selector: String(body.selector ?? ''),
          kilnId: (body.kilnId as string | null) ?? null,
        });
        await sendJson(res, 200, resolved);
      } catch (error) {
        await sendJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (path === '/api/edit-instruction' && req.method === 'POST') {
      const body = await readBody(req);
      const instruction = await app.buildEditInstruction({
        selector: String(body.selector ?? ''),
        kilnId: (body.kilnId as string | null) ?? null,
        intent: String(body.intent ?? ''),
      });
      if (!instruction) {
        await sendJson(res, 404, {
          error: 'That element has no source index yet. Try again once the dev server has compiled it.',
        });
        return;
      }
      await sendJson(res, 200, { instruction });
      return;
    }

    if (path === '/api/inspect' && req.method === 'POST') {
      const body = await readBody(req);
      const report = app.browser ? await inspect(app, String(body.selector ?? '')) : null;
      await sendJson(res, 200, { report });
      return;
    }

    if (path.startsWith('/api/')) {
      await sendJson(res, 404, { error: `no route for ${path}` });
      return;
    }

    if (await serveStatic(res, path)) return;

    // Single-page app: unknown paths fall back to the shell.
    if (existsSync(join(UI_ROOT, 'index.html')) && await serveStatic(res, '/')) return;

    send(
      res,
      404,
      '<h1>Kiln</h1><p>The UI has not been built. Run <code>npm run build:ui</code>.</p>',
      'text/html; charset=utf-8',
    );
  }

  let port = 0;

  return {
    listen(requested = 0) {
      return new Promise<ServerHandle>((resolve, reject) => {
        // Without this, a busy port escapes as an unhandled 'error' event and
        // takes the process down with a raw Node stack trace.
        const onError = (error: NodeJS.ErrnoException) => {
          server.removeListener('error', onError);
          if (error.code === 'EADDRINUSE') {
            reject(
              new Error(
                `Port ${requested} is already in use. Close whatever is using it, ` +
                  'or pass a different one: kiln --port 3001',
              ),
            );
            return;
          }
          if (error.code === 'EACCES') {
            reject(new Error(`Not allowed to listen on port ${requested}. Try a port above 1024.`));
            return;
          }
          reject(error);
        };
        server.on('error', onError);

        server.listen(requested, '127.0.0.1', () => {
          server.removeListener('error', onError);
          port = (server.address() as { port: number }).port;
          resolve({
            port,
            close: () =>
              new Promise<void>((done) => {
                unsubscribe();
                for (const client of clients) client.end();
                clients.clear();
                server.closeAllConnections?.();
                server.close(() => done());
              }),
          });
        });
      });
    },
  };
}

async function inspect(app: App, selector: string) {
  return app.browser ? inspectElement(app.browser, selector) : null;
}
