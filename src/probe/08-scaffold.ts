import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field, log, verdict } from './harness.ts';
import { App } from '../daemon/app.ts';
import { createDaemon } from '../daemon/server.ts';
import type { AppState } from '../daemon/app.ts';

const work = await mkdtemp(join(tmpdir(), 'kiln-scaffold-'));

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

  const before = (await (await fetch(`${base}/api/state`)).json()) as AppState;
  field('files at start', 0);
  field('preview before', before.preview.url ?? '(none)');

  const project = app;
  const events: string[] = [];
  let sawPreview = false;
  const turnDone = new Promise<boolean>((resolve) => {
    const off = project.subscribe((event) => {
      if (event.kind === 'preview') {
        sawPreview = true;
        events.push(`preview up: ${event.url}`);
      }
      if (event.kind === 'server.log') events.push(event.line);
      if (event.kind === 'deps.starting') events.push(`installing ${event.manager}`);
      if (event.kind === 'deps.done') events.push(`install ${event.manager} ok=${event.ok} ${event.detail}`);
      if (event.kind === 'turn.done') {
        off();
        resolve(true);
      }
    });
  });

  await fetch(`${base}/api/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: [
        'Scaffold a minimal Vite + React app in this empty directory.',
        'Use `npm create vite@latest . -- --template react` or write the files yourself,',
        'then add a `dev` script that runs vite on port 5173.',
        'Add a heading that says "Kiln works".',
      ].join(' '),
    }),
  });

  const completed = await turnDone;
  const after = (await (await fetch(`${base}/api/state`)).json()) as AppState;

  field('turn completed', completed);
  field('preview after', after.preview.url ?? '(none)');
  field('framework', after.preview.framework ?? '(none)');
  field('preview announced', sawPreview);
  field('lastError', after.lastError ?? 'null');
  field('log tail', events.slice(-4));

  const packageJson = await readFile(join(work, 'package.json'), 'utf8').catch(() => '');
  field('package.json written', packageJson ? JSON.parse(packageJson).scripts?.dev ?? '(no dev script)' : '(missing)');

  log('');
  const scaffolded = packageJson.includes('dev');
  const previewUp = Boolean(after.preview.url);
  field('scaffolded', scaffolded);
  field('preview came up on its own', previewUp);

  ok = scaffolded && previewUp;
  verdict(ok, 'm1 empty directory to running preview, with no user action');
} finally {
  await close?.();
  await app?.stop();
  await rm(work, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
