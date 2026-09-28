import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { field, log, verdict } from './harness.ts';
import { App } from '../daemon/app.ts';
import { createDaemon } from '../daemon/server.ts';
import type { AppState } from '../daemon/app.ts';
import type { ElementReport } from '../capture/element.ts';
import type { ResolvedElement } from '../provenance/resolve.ts';
import { git } from '../project/history.ts';

type SelectionResult = { report: ElementReport | null; exact: ResolvedElement | null };

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', '..', 'test', 'fixtures', 'jsx-app');

let app: App | null = null;
let close: (() => Promise<void>) | null = null;
let ok = false;

try {
  // A copy, because the agent will edit the file and the fixture is tracked.
  // Staged outside the repo so the project gets its own git history rather than
  // inheriting this repository's.
  // Staged beside the fixture so the dev server's file watcher works, and given
  // its own git repository so it does not inherit this one's history.
  const { cp, mkdir, mkdtemp, rm } = await import('node:fs/promises');
  await mkdir(join(fixture, '.staged'), { recursive: true });
  const work = await mkdtemp(join(fixture, '.staged', 'editor-'));

  await cp(join(fixture, 'src'), join(work, 'src'), { recursive: true });
  for (const file of ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts']) {
    await cp(join(fixture, file), join(work, file));
  }
  await git(['init', '-q'], work);

  const indexFile = join(work, '.kiln', 'provenance.json');
  process.env.KILN_PROVENANCE_PLUGIN = join(here, '..', 'provenance', 'plugin.ts');
  process.env.KILN_PROVENANCE_OUT = indexFile;

  app = new App({ dir: work, headless: true, autoApprove: true });
  await app.start();

  const daemon = createDaemon(app);
  const handle = await daemon.listen(0);
  close = handle.close;
  const base = `http://127.0.0.1:${handle.port}`;
  app.setDaemonOrigin(base);

  const before = (await (await fetch(`${base}/api/state`)).json()) as AppState;
  field('preview up', Boolean(before.preview.url));
  field('lastError', before.lastError ?? 'null');
  const indexExists = await readFile(indexFile, 'utf8').then(() => true, () => false);
  field('provenance index written', indexExists);

  // What the injected client posts on Alt-click.
  const selected = (await (
    await fetch(`${base}/api/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selector: '#submit-btn', kilnId: null }),
    })
  ).json()) as SelectionResult;

  field('report resolved', selected.report?.tag ?? 'null');
  field('exact source found', selected.exact ? `${selected.exact.file.split('/').pop()}:${selected.exact.line}` : 'none');

  // The T1 id is only known from the DOM, so take it from the index directly.
  const index = JSON.parse(await readFile(indexFile, 'utf8')) as {
    elements: Array<{ id: string; attributes: Record<string, string> }>;
  };
  const buttonId = index.elements.find((e) => e.attributes.id === 'submit-btn')?.id ?? null;
  field('provenance id', buttonId);

  const exact = (await (
    await fetch(`${base}/api/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selector: '#submit-btn', kilnId: buttonId }),
    })
  ).json()) as SelectionResult;

  field('exact via id', exact.exact ? `${exact.exact.file.split('/').pop()}:${exact.exact.line}` : 'none');

  const editResponse = await fetch(`${base}/api/edit-instruction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selector: '#submit-btn', kilnId: buttonId, intent: 'change the button text to Send it' }),
  });
  field('edit endpoint', editResponse.status);
  const { instruction, error } = (await editResponse.json()) as { instruction?: string; error?: string };
  if (!instruction) throw new Error(`no instruction returned: ${error ?? 'unknown'}`);

  log('');
  log('  instruction sent to the agent:');
  log(instruction.split('\n').map((l) => `    ${l}`).join('\n'));
  log('');

  const names = instruction;
  field('names the file', names.includes('App.jsx'));
  field('names the line', /App\.jsx:\d+/.test(names));
  field('path is project-relative', !names.includes(work));
  field('quotes current source', names.includes('submit-btn'));
  field('scopes the change', names.includes('Do not restructure'));

  // And the agent can actually act on it.
  const project = app;
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
    body: JSON.stringify({ text: instruction }),
  });
  const checkpoint = await turnDone;

  const after = await readFile(join(work, 'src', 'App.jsx'), 'utf8');
  field('agent applied the edit', /Send it/.test(after));
  field('turn checkpointed', Boolean(checkpoint));
  field('unrelated markup intact', after.includes('footer') && after.includes('<Footer />'));

  ok =
    Boolean(exact.exact) &&
    names.includes('App.jsx') &&
    /Send it/.test(after) &&
    after.includes('<Footer />');

  log('');
  verdict(ok, 'm2 click-to-edit: select resolves to source and the agent applies it');

  await rm(work, { recursive: true, force: true });
} finally {
  await close?.();
  await app?.stop();
}

process.exit(ok ? 0 : 1);
