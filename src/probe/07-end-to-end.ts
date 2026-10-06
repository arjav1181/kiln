import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field, log, verdict } from './harness.ts';
import { App } from '../daemon/app.ts';
import { createDaemon } from '../daemon/server.ts';
import { git } from '../project/history.ts';
import type { AppState } from '../daemon/app.ts';


const work = await mkdtemp(join(tmpdir(), 'kiln-e2e-'));
await writeFile(
  join(work, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>E2E</title></head><body><h1>start</h1><script>console.error("boom")</script></body></html>',
);
await writeFile(join(work, 'server.mjs'), `
import { createServer } from 'node:http';
// Bind an ephemeral port and announce it, so the probe never collides with a
// stale listener.
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><meta charset="utf-8"><title>E2E</title></head><body><h1>hello</h1></body></html>');
});
server.listen(0, '127.0.0.1', () => console.log('listening on ' + server.address().port));
`);
await writeFile(join(work, 'package.json'), JSON.stringify({ name: 'e2e', private: true, scripts: { dev: 'node server.mjs' } }, null, 2));

let app: App | null = null;
let close: (() => Promise<void>) | null = null;
let ok = false;

try {
  app = new App({ dir: work, headless: true, autoApprove: true });
  await app.start();

  const daemon = createDaemon(app);
  const handle = await daemon.listen(0);
  close = handle.close;
  const base = `http://127.0.0.1:${handle.port}`;
  app.setDaemonOrigin(base);

  const state = (await (await fetch(`${base}/api/state`)).json()) as AppState;
  field('dir', state.dir);
  field('preview url', state.preview.url);
  field('framework', state.preview.framework);
  field('lastError', state.lastError);

  const shell = await fetch(`${base}/`);
  const shellHtml = await shell.text();
  field('ui served', shell.status === 200 && shellHtml.includes('<div id="root">'));

  const previewUrl = state.preview.url!;
  const previewHtml = await (await fetch(previewUrl)).text();
  field('preview injected', previewHtml.includes('/__kiln/client.js') && previewHtml.includes('<h1>hello</h1>'));

  const client = await fetch(`${new URL(previewUrl).origin}/__kiln/client.js`);
  const clientJs = await client.text();
  field('client served', client.status === 200 && clientJs.includes(base));

  // A real turn: the agent writes a file, and that becomes a checkpoint.
  const project = app;
  let reply = '';
  let stopReason: string | null = null;
  project.subscribe((event) => {
    if (event.kind === 'tool.start') log(`  tool  ${event.name}`);
    if (event.kind === 'fatal') log(`  fatal ${event.message}`);
    if (event.kind === 'text') reply += event.delta;
    if (event.kind === 'turn.end') stopReason = event.stopReason;
    if (event.kind === 'deps.starting') log(`  deps  installing with ${event.manager}`);
    if (event.kind === 'deps.done') log(`  deps  ${event.manager} ok=${event.ok} ${event.detail}`);
  });

  const turnDone = new Promise<string>((resolve) => {
    const off = project.subscribe((event) => {
      if (event.kind === 'turn.done') {
        off();
        resolve(event.checkpointId ?? '');
      }
    });
  });

  await fetch(`${base}/api/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Create a file named note.txt containing the single word HELLO. Reply with just OK.' }),
  });

  const checkpointId = await turnDone;
  field('checkpoint created', checkpointId ? checkpointId.slice(0, 8) : '(none)');

  const onDisk = await readFile(join(work, 'note.txt'), 'utf8').catch(() => '(missing)');
  field('agent wrote file', onDisk.trim());

  const committed = await git(['show', '--name-only', '--format=', checkpointId], work).catch(() => '');
  field('file committed', committed.trim());

  field('stop reason', stopReason ?? '(none)');
  field('agent said', reply.trim().slice(0, 200));
  const after = (await (await fetch(`${base}/api/state`)).json()) as AppState;
  field('checkpoints listed', after.checkpoints.length);
  field('cost recorded', `$${after.costUsd.toFixed(4)}`);
  field('busy cleared', after.busy === false);

  // Restore: git rewinds the file, the SDK rewinds the conversation.
  const restore = await fetch(`${base}/api/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ checkpointId }),
  });
  field('restore accepted', restore.status === 200);

  const noteAfterRestore = await readFile(join(work, 'note.txt'), 'utf8').catch(() => '(missing)');
  field('note.txt after restore', noteAfterRestore.trim());

  const emptyPrompt = await fetch(`${base}/api/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  });
  field('empty prompt rejected', emptyPrompt.status === 400);

  const written =
    onDisk.trim() === 'HELLO' &&
    committed.includes('note.txt') &&
    after.checkpoints.length >= 1 &&
    after.busy === false;

  log('');
  field('turn produced a checkpoint', Boolean(checkpointId) && written);
  verdict(Boolean(checkpointId) && written, 'm1 end-to-end: daemon, preview, turn, checkpoint, restore');
  ok = Boolean(checkpointId) && written;
} finally {
  await close?.();
  await app?.stop();
  await rm(work, { recursive: true, force: true });
  await rm(join(work, '.git'), { recursive: true, force: true }).catch(() => {});
}

process.exit(ok ? 0 : 1);
