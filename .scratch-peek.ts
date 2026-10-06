import { writeFile } from 'node:fs/promises';
import { launchBrowser } from '/home/runner/workspace/live-site/src/capture/browser.ts';
const base = process.argv[2]!;
const browser = await launchBrowser();
await browser.goto(`${base}/`);
await new Promise((r) => setTimeout(r, 2500));
const modal = await browser.evaluate<string>(`
  (() => {
    const m = document.querySelector('.modal');
    if (!m) return 'no modal';
    const pre = m.querySelector('pre')?.textContent ?? '';
    return JSON.stringify({
      title: m.querySelector('h3')?.textContent,
      sub: m.querySelector('.sub')?.textContent,
      buttons: [...m.querySelectorAll('button')].map(b => b.textContent),
      input: pre.slice(0, 220),
    }, null, 2);
  })()
`);
console.log(modal);
await writeFile('/tmp/opencode/pub-3-permission.png', Buffer.from(await browser.screenshot(), 'base64'));
await browser.close();
