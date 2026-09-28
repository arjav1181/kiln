import { createServer } from 'node:http';
import { Probe, field, log, verdict } from './harness.ts';
import { launchBrowser, type Browser } from '../capture/browser.ts';
import { createKilnServer } from '../sdk/tools.ts';
import { Session } from '../sdk/session.ts';

const TOKEN = 'KILN4931';

// A page whose only useful information is what it looks like.
const site = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html><body style="margin:0;background:#fff">
       <div style="font:700 64px system-ui;padding:80px;color:#111">${TOKEN}</div>
     </body></html>`,
  );
});
const sitePort = await new Promise<number>((r) => site.listen(0, '127.0.0.1', () => r((site.address() as { port: number }).port)));

let browser: Browser | null = null;
let session: Session | null = null;
let ok = false;

try {
  browser = await launchBrowser();
  await browser.goto(`http://127.0.0.1:${sitePort}/`);

  let shot = '';
  const deps = {
    preview: () => ({ running: true, url: `http://127.0.0.1:${sitePort}/`, framework: 'test' }),
    captureScreenshot: async () => {
      shot = await browser!.screenshot();
      return { base64: shot, mimeType: 'image/png' };
    },
    readConsole: async () => ({ errors: [], networkFailures: [], pageErrors: [] }),
    inspectElement: async () => null,
    askUser: async () => 'blue',
  };

  session = Session.open({
    cwd: '/tmp',
    mcpServers: { kiln: createKilnServer(deps) },
    onPermission: async (request) =>
      request.toolName.startsWith('mcp__kiln__')
        ? { allow: true, remember: false }
        : { allow: false, reason: 'denied by probe' },
  });

  const probe = new Probe(session);
  const turn = await probe.send(
    'Call the preview_screenshot tool once. It returns an image. ' +
      'Then reply with the exact uppercase text you can read in that image, and nothing else.',
  );

  field('tools used', turn.tools);
  field('screenshot bytes', shot.length);
  field('agent reply', JSON.stringify(turn.text.trim()).slice(0, 200));
  field('cost', `$${turn.costUsd.toFixed(4)}`);

  const usedTool = turn.tools.includes('mcp__kiln__preview_screenshot');
  const sawImage = turn.text.toUpperCase().includes(TOKEN);
  const notGuessing = !/cannot|no image|unable|error/i.test(turn.text);

  log('');
  field('tool was called', usedTool);
  field('image reached the model', sawImage);
  field('agent did not bail out', notGuessing);

  ok = usedTool && sawImage;
  verdict(ok, 'm1 visual loop: the model receives a real screenshot');
} finally {
  await session?.close().catch(() => {});
  await browser?.close();
  site.close();
}

process.exit(ok ? 0 : 1);
