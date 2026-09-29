import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { field, log, verdict } from './harness.ts';
import { startDevServer } from '../runtime/manager.ts';
import { createProxy } from '../proxy/server.ts';
import { launchBrowser } from '../capture/browser.ts';
import { inspectElement } from '../capture/element.ts';
import { startProbe } from './harness.ts';
import type { Browser } from '../capture/browser.ts';
import type { Server } from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const goFixture = join(here, '..', '..', 'test', 'fixtures', 'go-app');

/** Elements chosen to span tag, depth and attribute shapes. */
const TARGETS = [
  '#submit-btn',
  '#email',
  'nav a.nav-link',
  '#features .feature',
  '#site-footer .muted',
  'em#inline-note',
];

type Hit = { selector: string; expectedFile: string; expectedLine: number; file: string | null; line: number | null };

/** Ground truth lives in the template files, which is where a real fix would go. */
const TRUTH: Record<string, { file: string; needle: string }> = {
  '#submit-btn': { file: 'templates/signup.html', needle: 'id="submit-btn"' },
  '#email': { file: 'templates/signup.html', needle: 'id="email" name="email"' },
  'nav a.nav-link': { file: 'templates/nav.html', needle: 'class="nav-link">{{.home}}' },
  // The selector matches li.feature, not the ul, so the row is the right answer.
  '#features .feature': { file: 'templates/features.html', needle: '<li class="feature">Fast' },
  '#site-footer .muted': { file: 'templates/footer.html', needle: 'id="site-footer"' },
  'em#inline-note': { file: 'templates/features.html', needle: 'id="inline-note"' },
};

let client: Server | null = null;
let proxy: ReturnType<typeof createProxy> | null = null;
let browser: Browser | null = null;
let server: Awaited<ReturnType<typeof startDevServer>> | null = null;
let ok = false;

try {
  const expected: Record<string, { file: string; line: number }> = {};
  for (const [selector, spec] of Object.entries(TRUTH)) {
    const text = await readFile(join(goFixture, spec.file), 'utf8');
    expected[selector] = {
      file: spec.file,
      line: text.split('\n').findIndex((l) => l.includes(spec.needle)) + 1,
    };
  }
  field('template files', Object.values(expected).length ? new Set(Object.values(expected).map((e) => e.file)).size : 0);

  client = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end('/* kiln */');
  });
  const clientPort = await new Promise<number>((r) =>
    client!.listen(0, '127.0.0.1', () => r((client!.address() as { port: number }).port)),
  );

  server = await startDevServer({ cwd: goFixture, readyTimeoutMs: 60_000 });
  proxy = createProxy({ host: '127.0.0.1', port: server.port, client: { origin: `http://127.0.0.1:${clientPort}` } });
  const proxyPort = await proxy.listen(0);
  browser = await launchBrowser();
  await browser.goto(`http://127.0.0.1:${proxyPort}/`);

  // Exactly what an Alt-click yields: no file list, no source hints.
  const reports = [] as unknown[];
  for (const selector of TARGETS) {
    const report = await inspectElement(browser, selector);
    if (report) reports.push(report);
  }
  field('elements captured', reports.length);

  const probe = startProbe(goFixture, { session: { onPermission: async () => ({ allow: true, remember: false }) } });
  const turn = await probe.send(
    [
      'A user clicked each of these elements in a running app, one after another.',
      'For EACH element, find the source file and line that defines it.',
      '',
      '```json',
      JSON.stringify(reports, null, 2),
      '```',
      '',
      'Answer with one line per element, in the same order, in exactly this format:',
      'SELECTOR=<selector> FILE=<relative path> LINE=<line number>',
    ].join('\n'),
  );

  const hits: Hit[] = TARGETS.map((selector) => {
    const match = new RegExp(`SELECTOR=${selector.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')}\\s+FILE=(\\S+)\\s+LINE=(\\d+)`, 'i')
      .exec(turn.text);
    return {
      selector,
      expectedFile: expected[selector]!.file,
      expectedLine: expected[selector]!.line,
      file: match?.[1]?.replace(/^\.\//, '') ?? null,
      line: match ? Number(match[2]) : null,
    };
  });

  let fileHits = 0;
  let lineHits = 0;
  log('');
  for (const hit of hits) {
    // The agent reports paths relative to wherever it is looking, so compare on
    // the tail rather than demanding one exact spelling.
    const fileOk = hit.file === hit.expectedFile || Boolean(hit.file?.endsWith(`/${hit.expectedFile}`));
    const lineOk = fileOk && hit.line !== null && Math.abs(hit.line - hit.expectedLine) <= 3;
    if (fileOk) fileHits += 1;
    if (lineOk) lineHits += 1;
    log(
      `  ${lineOk ? 'exact' : fileOk ? 'file' : 'MISS '}  ${hit.selector.padEnd(22)} ` +
        `got ${hit.file ?? '?'}:${hit.line ?? '?'}  want ${hit.expectedFile}:${hit.expectedLine}`,
    );
  }

  const total = hits.length;
  const fileRate = fileHits / total;
  const lineRate = lineHits / total;
  field('file accuracy', `${fileHits}/${total} = ${(fileRate * 100).toFixed(0)}%`);
  field('exact-line accuracy', `${lineHits}/${total} = ${(lineRate * 100).toFixed(0)}%`);
  field('cost', `$${turn.costUsd.toFixed(4)}`);

  // T0 is a fallback tier, so it is acceptable to be imperfect; it is not
  // acceptable for it to never work.
  ok = lineRate >= 0.5;
  log('');
  verdict(ok, 'm1 T0 hit rate measured across element shapes, on the hardest stack');

  await probe.session.close();
} finally {
  await browser?.close();
  await proxy?.close();
  server?.stop();
  client?.close();
}

process.exit(ok ? 0 : 1);
