import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { field, log, verdict, waitFor } from './harness.ts';
import { App } from '../daemon/app.ts';
import { createDaemon } from '../daemon/server.ts';
import { git } from '../project/history.ts';
import type { AppState } from '../daemon/app.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', '..', 'test', 'fixtures', 'jsx-app');

let app: App | null = null;
let close: (() => Promise<void>) | null = null;
let ok = false;

/**
 * The real user path: a Vite project with a completely ordinary config that has
 * never heard of Kiln. Exact click-to-edit has to work anyway, and the project
 * must come out the other side untouched.
 */
try {
  const { cp, mkdir, mkdtemp, rm, symlink } = await import('node:fs/promises');
  await mkdir(join(fixture, '.staged'), { recursive: true });
  const work = await mkdtemp(join(fixture, '.staged', 'inject-'));

  await cp(join(fixture, 'src'), join(work, 'src'), { recursive: true });
  for (const file of ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts']) {
    await cp(join(fixture, file), join(work, file));
  }
  await symlink(join(fixture, 'node_modules'), join(work, 'node_modules'), 'dir');
  await git(['init', '-q'], work);

  const userConfig = join(work, 'vite.config.ts');
  const configBefore = await readFile(userConfig, 'utf8');

  app = new App({ dir: work, autoApprove: true });
  await app.start();

  const daemon = createDaemon(app);
  const handle = await daemon.listen(0);
  close = handle.close;
  app.setDaemonOrigin(`http://127.0.0.1:${handle.port}`);

  const base = `http://127.0.0.1:${handle.port}`;
  const state = (await (await fetch(`${base}/api/state`)).json()) as AppState;
  field('preview up', Boolean(state.preview.url));
  field('lastError', state.lastError ?? 'null');
  if (!state.preview.url) throw new Error('the preview never came up');

  const browser = app.browser!;
  const id = await waitFor(
    () => browser.evaluate<string | null>(
      "document.querySelector('#submit-btn')?.getAttribute('data-kiln-id') ?? null",
    ),
    (value) => Boolean(value),
    45_000,
  );
  field('data-kiln-id in a plain vite app', id ?? '(none)');

  // Alt-click carries the id through to an exact resolution.
  const selected = (await (
    await fetch(`${base}/api/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selector: '#submit-btn', kilnId: id }),
    })
  ).json()) as { exact: { file: string; line: number } | null };
  field('resolves to', selected.exact ? `${selected.exact.file}:${selected.exact.line}` : '(nothing)');

  const wrapper = await readFile(join(work, '.kiln', 'vite.config.mjs'), 'utf8').then(() => true, () => false);
  field('wrapper config generated', wrapper);

  const configAfter = await readFile(userConfig, 'utf8');
  field("user's vite.config.ts untouched", configAfter === configBefore);

  await rm(work, { recursive: true, force: true });

  ok = Boolean(id) && Boolean(selected.exact) && wrapper && configAfter === configBefore;
  log('');
  verdict(ok, 'm2 provenance injected without modifying the project');
} finally {
  await close?.();
  await app?.stop();
}

process.exit(ok ? 0 : 1);