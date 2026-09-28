import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ElementReport = {
  selector: string;
  tag: string;
  attributes: Record<string, string>;
  outerHTML: string;
  accessibleName: string | null;
  rect: { x: number; y: number; width: number; height: number };
  domPath: string;
};

const CHROME = process.env.KILN_CHROME ?? '/repl/tools/bin/chromium';

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function waitForDebugger(port: number, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    const page = targets && ((await targets.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>)
      .find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Chrome DevTools endpoint did not come up');
}

export type Browser = {
  goto: (url: string) => Promise<void>;
  evaluate: <T>(expression: string) => Promise<T>;
  close: () => Promise<void>;
};

export async function launchBrowser(): Promise<Browser> {
  const port = await freePort();
  const userDataDir = await mkdtemp(join(tmpdir(), 'kiln-chrome-'));

  const child: ChildProcess = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  );

  const socketUrl = await waitForDebugger(port);
  const socket = new WebSocket(socketUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (frame.id === undefined) return;
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    if (frame.error) waiter.reject(new Error(frame.error.message));
    else waiter.resolve(frame.result);
  });

  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  await send('Page.enable');
  await send('Runtime.enable');

  const evaluate = async <T>(expression: string): Promise<T> => {
    const frame = (await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text: string } };
    if (frame.exceptionDetails) throw new Error(frame.exceptionDetails.text);
    return frame.result?.value as T;
  };

  const goto = async (url: string) => {
    await send('Page.navigate', { url });
    const deadline = Date.now() + 20_000;
    for (;;) {
      const state = await evaluate<string>('document.readyState').catch(() => null);
      if (state === 'complete' || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 350));
  };

  const close = async () => {
    try {
      socket.close();
    } catch {
      // already closed
    }
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  };

  return { goto, evaluate, close };
}

const INSPECT = `
(() => {
  const el = document.querySelector(SEL);
  if (!el) return null;
  const name = el.getAttribute('aria-label')
    || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')?.textContent)
    || el.textContent?.trim()
    || el.getAttribute('title')
    || null;
  const r = el.getBoundingClientRect();
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
    parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : ''));
  }
  const attributes = {};
  for (const a of el.attributes) attributes[a.name] = a.value;
  return {
    selector: $(sel),
    tag: el.tagName.toLowerCase(),
    attributes,
    outerHTML: el.outerHTML.slice(0, 600),
    accessibleName: name,
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    domPath: parts.join(' > '),
  };
})()
`;

export async function inspectElement(page: Browser, selector: string): Promise<ElementReport | null> {
  const expression = INSPECT.replaceAll('SEL', JSON.stringify(selector)).replace('$(sel)', JSON.stringify(selector));
  return page.evaluate<ElementReport | null>(expression);
}
