import { field, log, verdict } from './harness.ts';
import { detectDevServer } from '../runtime/detect.ts';
import { startDevServer } from '../runtime/manager.ts';
import { createProxy, INJECTED_CLIENT } from '../proxy/server.ts';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'test', 'fixtures');

type Outcome = {
  label: string;
  detected: string | null;
  port: number | null;
  upstreamOk: boolean;
  proxiedOk: boolean;
  injected: boolean;
  clientServed: boolean;
  contentPreserved: boolean;
};

async function exercise(label: string, dir: string): Promise<Outcome> {
  const detected = await detectDevServer(dir);
  const outcome: Outcome = {
    label,
    detected: detected ? `${detected.command} ${detected.args.join(' ')}` : null,
    port: null,
    upstreamOk: false,
    proxiedOk: false,
    injected: false,
    clientServed: false,
    contentPreserved: false,
  };

  const server = await startDevServer({ cwd: dir, readyTimeoutMs: 60_000 });
  outcome.port = server.port;

  const clientServer = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(INJECTED_CLIENT);
  });
  const clientPort = await new Promise<number>((resolve) => {
    clientServer.listen(0, '127.0.0.1', () => resolve((clientServer.address() as { port: number }).port));
  });

  const proxy = createProxy({ host: '127.0.0.1', port: server.port, clientUrl: `http://127.0.0.1:${clientPort}/client.js` });
  const proxyPort = await proxy.listen(0);

  try {
    const upstream = await fetch(`http://127.0.0.1:${server.port}/`);
    outcome.upstreamOk = upstream.ok;
    await upstream.text();

    const proxied = await fetch(`http://127.0.0.1:${proxyPort}/`);
    const html = await proxied.text();
    outcome.proxiedOk = proxied.ok;
    outcome.injected = html.includes('/client.js') && html.includes('<head');
    outcome.clientServed = (await fetch(`http://127.0.0.1:${clientPort}/client.js`)).ok;
    outcome.contentPreserved = html.includes('submit-btn') && html.includes('</html>');

    field(`${label} head`, html.match(/<head[^>]*>.{0,90}/s)?.[0].replace(/\s+/g, ' '));
  } finally {
    await proxy.close();
    server.stop();
    clientServer.close();
  }

  return outcome;
}

log('M0.6 / M0.7 / M0.8  stack-agnostic runtime + proxy injection\n');

const results: Outcome[] = [];
results.push(await exercise('node  ', join(fixtures, 'node-app')));
results.push(await exercise('go    ', join(fixtures, 'go-app')));

log('');
for (const r of results) {
  field(r.label, {
    detected: r.detected,
    port: r.port,
    upstream: r.upstreamOk,
    proxied: r.proxiedOk,
    injected: r.injected,
    contentKept: r.contentPreserved,
  });
}

const allDetected = results.every((r) => r.detected !== null);
const allInjected = results.every((r) => r.injected && r.proxiedOk && r.upstreamOk && r.contentPreserved);
const portsDiscovered = results.every((r) => r.port !== null);

log('');
field('all stacks detected', allDetected);
field('ports discovered', portsDiscovered);
field('injection on every stack', allInjected);

const ok = allDetected && allInjected && portsDiscovered;
verdict(ok, 'm0.6 vite + m0.7 GATE non-node + m0.8 runtime manager');
process.exit(ok ? 0 : 1);
