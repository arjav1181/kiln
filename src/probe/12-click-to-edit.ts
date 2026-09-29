import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { field, log, verdict, waitFor } from './harness.ts';
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
  const { cp, mkdir, mkdtemp, rm, symlink, writeFile } = await import('node:fs/promises');
  await mkdir(join(fixture, '.staged'), { recursive: true });
  const work = await mkdtemp(join(fixture, '.staged', 'editor-'));

  await cp(join(fixture, 'src'), join(work, 'src'), { recursive: true });
  for (const file of ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts']) {
    await cp(join(fixture, file), join(work, file));
  }
  // Reuse the fixture's dependencies rather than racing an install, and give
  // the copy its own repository so a checkpoint can never land in this one.
  await symlink(join(fixture, 'node_modules'), join(work, 'node_modules'), 'dir');
  await git(['init', '-q'], work);
  if (!(await readFile(join(work, '.git', 'HEAD'), 'utf8').then(() => true, () => false))) {
    throw new Error('the staged project has no git repository of its own');
  }

  // Guard: this probe lets an agent edit files. If staging ever regresses it
  // would rewrite the checked-in fixture, so assert the fixture is untouched.
  const trackedFixture = join(fixture, 'src', 'App.jsx');
  const fixtureBefore = await readFile(trackedFixture, 'utf8');

  process.env.KILN_PROVENANCE_PLUGIN = join(here, '..', 'provenance', 'plugin.ts');
  process.env.KILN_PROVENANCE_OUT = join(work, '.kiln', 'provenance.json');

  // Not headless: the ids come from the dev server compiling the page, which is
  // what happens when a user opens the preview.
  app = new App({ dir: work, autoApprove: true });
  await app.start();

  const daemon = createDaemon(app);
  const handle = await daemon.listen(0);
  close = handle.close;
  const base = `http://127.0.0.1:${handle.port}`;
  app.setDaemonOrigin(base);

  const before = (await (await fetch(`${base}/api/state`)).json()) as AppState;
  field('preview up', Boolean(before.preview.url));
  field('lastError', before.lastError ?? 'null');
  if (!before.preview.url) throw new Error('the preview never came up');

  // Wait for the app to mount and the transform-time ids to reach the page.
  const browser = app.browser!;
  const kilnId = await waitFor(
    () => browser.evaluate<string | null>(
      "document.querySelector('#submit-btn')?.getAttribute('data-kiln-id') ?? null",
    ),
    (id) => Boolean(id),
    45_000,
  );
  field('provenance id in the page', kilnId ?? '(none)');

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

  const exact = (await (
    await fetch(`${base}/api/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selector: '#submit-btn', kilnId }),
    })
  ).json()) as SelectionResult;

  field('exact via id', exact.exact ? `${exact.exact.file.split('/').pop()}:${exact.exact.line}` : 'none');

  const editResponse = await fetch(`${base}/api/edit-instruction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selector: '#submit-btn', kilnId, intent: 'change the button text to Send it' }),
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
  const tools: string[] = [];
  let reply = '';
  let stopReason: string | null = null;
  let turnError = false;
  const turnDone = new Promise<string>((resolve) => {
    const off = project.subscribe((event) => {
      if (event.kind === 'tool.start') tools.push(event.name);
      if (event.kind === 'turn.end') {
        stopReason = event.stopReason;
        turnError = event.isError;
      }
      if (event.kind === 'turn.done') {
        off();
        resolve(event.checkpointId ?? '');
      }
    });
  });
  const project2 = app;
  void project2.subscribe((event) => {
    if (event.kind === 'text') reply += event.delta;
  });

  await fetch(`${base}/api/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: instruction }),
  });
  const checkpoint = await turnDone;

  const after = await readFile(join(work, 'src', 'App.jsx'), 'utf8');
  field('tools the agent used', tools);
  field('stop reason', stopReason ?? '(none)');
  field('turn error', turnError);
  field('agent said', reply.trim().slice(0, 300));
  field('agent applied the edit', /Send it/.test(after));
  field('turn checkpointed', Boolean(checkpoint));
  field('unrelated markup intact', after.includes('footer') && after.includes('<Footer />'));
  // Repair rather than only complain: this probe lets an agent write files, and
  // a misresolved path must never leave the repository dirty.
  const fixtureAfter = await readFile(trackedFixture, 'utf8');
  if (fixtureAfter !== fixtureBefore) {
    await writeFile(trackedFixture, fixtureBefore);
    log('  (restored the tracked fixture after an agent write escaped the sandbox)');
  }
  field('checked-in fixture untouched', fixtureAfter === fixtureBefore);

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
