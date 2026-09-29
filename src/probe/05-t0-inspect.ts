import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { field, log, startProbe, verdict, withTempProject } from './harness.ts';
import { startDevServer } from '../runtime/manager.ts';
import { createProxy } from '../proxy/server.ts';
import { INJECTED_CLIENT } from '../proxy/client-script.ts';
import { launchBrowser } from '../capture/browser.ts';
import { inspectElement } from '../capture/element.ts';
import { createServer } from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const goFixture = join(here, '..', '..', 'test', 'fixtures', 'go-app');

// Ground truth for scoring the agent's answer. The markup lives in a template
// file, which is where a real fix would go.
const TRUTH_FILE = 'templates/signup.html';
const TRUTH_NEEDLE = 'id="submit-btn"';
const source = readFileSync(join(goFixture, TRUTH_FILE), 'utf8');
const truthLine = source.split('\n').findIndex((line) => line.includes(TRUTH_NEEDLE)) + 1;

const clientServer = createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'application/javascript' });
  res.end(INJECTED_CLIENT);
});
const clientPort = await new Promise<number>((resolve) => {
  clientServer.listen(0, '127.0.0.1', () => resolve((clientServer.address() as { port: number }).port));
});

const server = await startDevServer({ cwd: goFixture, readyTimeoutMs: 60_000 });
const proxy = createProxy({ host: '127.0.0.1', port: server.port, client: { origin: `http://127.0.0.1:${clientPort}` } });
const proxyPort = await proxy.listen(0);
const browser = await launchBrowser();
let ok = false;

try {
  await browser.goto(`http://127.0.0.1:${proxyPort}/`);

  const injected = await browser.evaluate<boolean>('!!window.__kiln');
  field('client injected in page', injected);

  const report = await inspectElement(browser, '#submit-btn');
  field('selector', report?.selector);
  field('tag', report?.tag);
  field('accessibleName', report?.accessibleName);
  field('attributes', report?.attributes);
  field('domPath', report?.domPath);
  field('rect', report?.rect);

  // T0 hands the agent only what a click would give it: no file list, no
  // source. If it can still name the right file and line, T0 works.
  const probe = startProbe(goFixture, { session: { onPermission: async () => ({ allow: true, remember: false }) } });
  const turn = await probe.send(
    [
      'A user clicked this element in the running app:',
      '```json',
      JSON.stringify(report, null, 2),
      '```',
      'Without modifying anything, find the source file and line that defines this element.',
      'Reply in exactly this format and nothing else:',
      'FILE=<relative path> LINE=<line number>',
    ].join('\n'),
  );

  field('agent reply', turn.text.trim().slice(0, 200));
  field('ground truth', `${TRUTH_FILE}:${truthLine}`);

  const answer = `${turn.result}\n${turn.text}`;
  const gotFile = /FILE=\s*(\S+)/i.exec(answer)?.[1]?.replace(/^\.\//, '') ?? null;
  const gotLine = Number(/LINE=\s*(\d+)/i.exec(answer)?.[1] ?? Number.NaN);
  const fileCorrect = gotFile === TRUTH_FILE;
  const lineCorrect = Number.isFinite(gotLine) && Math.abs(truthLine - gotLine) <= 5;

  log('');
  field('file correct', fileCorrect);
  field('line within 5 of truth', lineCorrect);
  field('cost', `$${turn.costUsd.toFixed(6)}`);

  ok = injected && report !== null && fileCorrect && lineCorrect;
  verdict(ok, 'm0.9 T0 click-to-inspect locates the source');
  await probe.session.close();
} finally {
  await browser.close();
  await proxy.close();
  server.stop();
  clientServer.close();
}

// Exit only after cleanup, so the port is released for the next probe.
process.exit(ok ? 0 : 1);
