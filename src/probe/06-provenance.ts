import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { field, log, verdict, waitFor } from './harness.ts';
import { startDevServer } from '../runtime/manager.ts';
import { createProxy } from '../proxy/server.ts';
import { INJECTED_CLIENT } from '../proxy/client-script.ts';
import { launchBrowser } from '../capture/browser.ts';
import { createServer } from 'node:http';
import type { ElementRef } from '../provenance/plugin.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixture = join(repoRoot, 'test', 'fixtures', 'jsx-app');
const pluginEntry = join(repoRoot, 'src', 'provenance', 'plugin.ts');

type Snapshot = { version: number; elements: ElementRef[] };

const truthLineOf = (source: string) =>
  source.split('\n').findIndex((line) => line.includes('id="submit-btn"')) + 1;

const findButton = (snapshot: Snapshot) =>
  snapshot.elements.find((e) => e.attributes.id === 'submit-btn');

// The probe rewrites the app repeatedly, so it works on a staged copy and never
// touches the checked-in fixture. Staged beside the fixture so node_modules
// resolves by directory walk instead of a cross-device symlink.
await mkdir(join(fixture, '.staged'), { recursive: true });
const work = await mkdtemp(join(fixture, '.staged', 'provenance-'));
const appFile = join(work, 'src', 'App.jsx');
const indexFile = join(work, '.kiln', 'provenance.json');

await cp(join(fixture, 'src'), join(work, 'src'), { recursive: true });
for (const file of ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts']) {
  await cp(join(fixture, file), join(work, file));
}

const original = await readFile(appFile, 'utf8');
const readIndex = async (): Promise<Snapshot> => JSON.parse(await readFile(indexFile, 'utf8')) as Snapshot;

const clientServer = createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'application/javascript' });
  res.end(INJECTED_CLIENT);
});
const clientPort = await new Promise<number>((resolve) => {
  clientServer.listen(0, '127.0.0.1', () => resolve((clientServer.address() as { port: number }).port));
});

let server: Awaited<ReturnType<typeof startDevServer>> | null = null;
let proxy: ReturnType<typeof createProxy> | null = null;
let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null;
let ok = false;

try {
  process.env.KILN_PROVENANCE_PLUGIN = pluginEntry;
  process.env.KILN_PROVENANCE_OUT = indexFile;
  server = await startDevServer({ cwd: work, readyTimeoutMs: 90_000 });

  proxy = createProxy({
    host: '127.0.0.1',
    port: server.port,
    client: { origin: `http://127.0.0.1:${clientPort}` },
  });
  const proxyPort = await proxy.listen(0);
  const upstream = server.url;

  // Liveness: the dev server's HMR socket has to survive the proxy, or the
  // preview never updates live.
  const wsOpened = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/`, 'vite-hmr');
    const timer = setTimeout(() => { ws.close(); resolve(false); }, 6000);
    ws.addEventListener('open', () => { clearTimeout(timer); ws.close(); resolve(true); });
    ws.addEventListener('error', () => { clearTimeout(timer); resolve(false); });
  });

  browser = await launchBrowser();
  const page = browser;
  const reload = () => page.goto(`http://127.0.0.1:${proxyPort}/`);
  const buttonId = () =>
    page.evaluate<string | null>("document.querySelector('#submit-btn')?.getAttribute('data-kiln-id') ?? null");
  const buttonText = () =>
    page.evaluate<string | null>("document.querySelector('#submit-btn')?.textContent?.trim() ?? null");

  // Re-requesting a module is what the HMR client does; it also makes the
  // provenance assertions independent of watcher timing in the sandbox.
  const recompile = (marker: string) =>
    waitFor(
      async () => (await (await fetch(`${upstream}/src/App.jsx?cb=${Date.now()}`)).text()).includes(marker),
      (done) => done,
      20_000,
    );

  await reload();
  const first = await readIndex();
  const firstButton = findButton(first);
  const attrFirst = await buttonId();

  field('index version', first.version);
  field('elements indexed', first.elements.length);
  field('button id', firstButton?.id);
  field('button file', firstButton?.file.split('/').slice(-2).join('/'));
  field('button line', `${firstButton?.line} (truth ${truthLineOf(original)})`);
  field('dom data-kiln-id', attrFirst);
  field('hmr socket through proxy', wsOpened);

  // HMR: a small in-place edit, as a normal turn produces.
  const edited = original.replace('JSX fixture', 'JSX fixture v2');
  await writeFile(appFile, edited);
  await recompile('JSX fixture v2');
  await reload();

  const afterHmr = await readIndex();
  const hmrButton = findButton(afterHmr);
  const attrHmr = await buttonId();

  field('', '');
  field('after edit id', hmrButton?.id);
  field('after edit line', `${hmrButton?.line} (truth ${truthLineOf(edited)})`);
  field('after edit dom id', attrHmr);
  field('id unchanged by edit', hmrButton?.id === firstButton?.id);

  // Full rewrite: the model replaces the file rather than nudging it.
  const rewritten = [
    '// regenerated by the agent',
    'export function App() {',
    '  return (',
    '    <main className="app">',
    '      <h1>JSX fixture v3</h1>',
    '      <section className="panel">',
    '        <button id="submit-btn" className="primary">',
    '          Send',
    '        </button>',
    '      </section>',
    '    </main>',
    '  );',
    '}',
    '',
  ].join('\n');
  await writeFile(appFile, rewritten);
  await recompile('Send');
  await reload();

  const afterRewrite = await readIndex();
  const rewriteButton = findButton(afterRewrite);
  const attrRewrite = await buttonId();
  const textRewrite = await buttonText();
  const resolved = afterRewrite.elements.find((e) => e.id === attrRewrite);
  const collisions = afterRewrite.elements.filter((e) => e.id === firstButton?.id);

  field('', '');
  field('after rewrite id', rewriteButton?.id);
  field('after rewrite line', `${rewriteButton?.line} (truth ${truthLineOf(rewritten)})`);
  field('after rewrite dom id', attrRewrite);
  field('after rewrite button text', textRewrite);
  field('that id resolves to', resolved ? `${resolved.tag}#${resolved.attributes.id ?? ''}` : '(nothing)');
  field('pre-rewrite id now', collisions.length ? `${collisions[0]!.tag}@${collisions[0]!.line}` : '(retired)');
  field('index grew monotonically', afterRewrite.version > first.version);

  const injectedThroughout =
    attrFirst === firstButton?.id && attrHmr === hmrButton?.id && attrRewrite === rewriteButton?.id;
  const linesCorrect =
    firstButton?.line === truthLineOf(original) &&
    hmrButton?.line === truthLineOf(edited) &&
    rewriteButton?.line === truthLineOf(rewritten);
  // The product invariant: whatever id the DOM carries must resolve back to the
  // element the user is looking at, and an id from before a rewrite must not
  // resolve to a different element that happens to sit at the same coordinates.
  const rewriteSafe =
    resolved?.tag === 'button' &&
    resolved?.attributes.id === 'submit-btn' &&
    textRewrite === 'Send' &&
    collisions.length === 0;

  log('');
  field('ids present in DOM throughout', injectedThroughout);
  field('index lines always correct', linesCorrect);
  field('rewrite fully re-derived', rewriteSafe);

  ok = injectedThroughout && linesCorrect && rewriteSafe && wsOpened;
  verdict(ok, 'm0.10 T1 transform-time ids survive HMR and full rewrite');
} finally {
  await browser?.close();
  await proxy?.close();
  server?.stop();
  clientServer.close();
  await rm(work, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
