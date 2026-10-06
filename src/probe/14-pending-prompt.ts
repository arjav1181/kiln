import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field, log, verdict, waitFor } from './harness.ts';
import { App } from '../daemon/app.ts';
import { createDaemon } from '../daemon/server.ts';
import { launchBrowser } from '../capture/browser.ts';
import type { AppState } from '../daemon/app.ts';

const work = await mkdtemp(join(tmpdir(), 'kiln-pending-'));

let app: App | null = null;
let close: (() => Promise<void>) | null = null;
let ok = false;

/**
 * A permission prompt must survive the browser going away. If it does not, the
 * agent turn blocks with nothing on screen until it times out.
 */
try {
  await writeFile(join(work, 'package.json'), JSON.stringify({ name: 'p', private: true, scripts: { dev: 'node s.mjs' } }));
  await writeFile(
    join(work, 's.mjs'),
    "import { createServer } from 'node:http';const s=createServer((_q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end('<!doctype html><html><head></head><body><h1>hi</h1></body></html>')});s.listen(0,'127.0.0.1',()=>console.log('listening on '+s.address().port));",
  );

  app = new App({ dir: work, headless: true, autoApprove: false });
  await app.start();

  const daemon = createDaemon(app);
  const handle = await daemon.listen(0);
  close = handle.close;
  const base = `http://127.0.0.1:${handle.port}`;
  app.setDaemonOrigin(base);

  const seen: string[] = [];
  app.subscribe((event) => {
    const kind = (event as { kind: string }).kind;
    if (kind === 'tool.start') seen.push(`tool ${(event as { name: string }).name}`);
    else if (kind === 'permission') seen.push('PERMISSION');
    else if (kind === 'question') seen.push('QUESTION');
    else if (kind === 'turn.end') seen.push(`turn.end tools=${(event as { stopReason: string | null }).stopReason}`);
    else if (kind === 'fatal') seen.push(`fatal ${(event as { message: string }).message}`);
  });

  const browser = await launchBrowser();
  await browser.goto(`${base}/`);

  await browser.evaluate(`(() => {
    const box = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, 'Create a file called notes.txt containing the word HI.');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Send')?.click();
    return true;
  })()`);

  const started = await waitFor(
    async () => ((await (await fetch(`${base}/api/state`)).json()) as AppState).busy,
    (busy) => busy,
    60_000,
  );
  field('turn started', started);

  await new Promise((r) => setTimeout(r, 45_000));
  field('events so far', seen.length ? seen : '(none)');

  // The agent asks to write a file, so a permission prompt must appear.
  type Outstanding = { kind: string };
  const readOutstanding = async (): Promise<Outstanding[]> =>
    ((await (await fetch(`${base}/api/outstanding`)).json()) as { outstanding: Outstanding[] }).outstanding;

  const outstanding = await waitFor(readOutstanding, (list) => list.length > 0, 180_000);
  field('prompt appeared', outstanding.length);
  if (!outstanding.length) {
    const s = (await (await fetch(`${base}/api/state`)).json()) as AppState;
    field('busy', s.busy);
    field('lastError', s.lastError ?? 'null');
    field('cost', s.costUsd);
  }

  // Now drop the browser entirely, the way closing a tab would.
  await browser.close();
  field('browser closed', true);

  const afterDisconnect = await readOutstanding();
  field('still outstanding after disconnect', afterDisconnect.length > 0);

  // A fresh visitor must be shown the waiting prompt.
  const again = await launchBrowser();
  await again.goto(`${base}/`);
  const modalText = await waitFor(
    () =>
      again.evaluate<string | null>(
        "document.querySelector('.modal h3')?.textContent ?? null",
      ),
    (text) => Boolean(text),
    20_000,
  );
  field('reconnect shows the prompt', modalText ?? '(none)');

  // And answering it unblocks the turn.
  await again.evaluate(`(() => {
    [...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === 'Allow')?.click();
    return true;
  })()`);

  const written = await waitFor(
    async () => await readFileSafe(join(work, 'notes.txt')),
    (value) => value.trim() === 'HI',
    180_000,
  );
  field('agent completed the turn', written.trim() || '(missing)');

  await again.close();
  ok = afterDisconnect.length > 0 && Boolean(modalText) && written.trim() === 'HI';
  log('');
  verdict(ok, 'm1 a pending prompt survives disconnect and can be answered after reconnect');
} finally {
  await close?.();
  await app?.stop();
  await rm(work, { recursive: true, force: true });
}

async function readFileSafe(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8').catch(() => '');
}

process.exit(ok ? 0 : 1);